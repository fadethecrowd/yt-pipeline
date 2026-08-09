import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  schedulerTick, isSchedulerEnabled,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS, SCHEDULER_ENABLED_VALUE,
  assertValidSlot, publicationPolicyFor, nextPublishSlot, describeSlot,
  zonedParts, CycleError,
  PIPELINE_HARD_TIMEOUT_MS, CLAIM_STALE_AFTER_MS,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, SchedulerDeps } from "@yt-pipeline/pipeline-core";

/**
 * The trigger layer.
 *
 * The scheduler is the only thing that decides a video is owed, so the property
 * these tests defend is that it can never decide it MORE than once, and can
 * never decide it at all unless explicitly armed. Its blast radius is one row;
 * everything below is about keeping it to one row.
 */

const SCHED = readFileSync("packages/pipeline-core/src/lib/authorizationScheduler.ts", "utf8");
const TICK = readFileSync("packages/monitor/src/authorizationTick.ts", "utf8");
const CTRL = readFileSync("scripts/authorization-scheduler-control.ts", "utf8");
const MONITOR = readFileSync("packages/monitor/src/index.ts", "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TZ = "America/New_York";
const AI = "ai-doom-scroll";
const WC = "wet-circuit";
const ON = { SCHEDULER_ENABLED: "true" } as NodeJS.ProcessEnv;

/** Monday 2026-08-10 15:00 EDT === 19:00Z. */
const MON_SLOT = new Date("2026-08-10T19:00:00.000Z");

/** A fake table that enforces the same unique (channel, slot) index. */
class FakeStore {
  rows: ProductionCycle[] = [];
  writes = 0;
  private seq = 0;

  deps(nextSlot: Date, openOverride?: ProductionCycle | null): SchedulerDeps {
    return {
      nextSlot: async () => nextSlot,
      validate: assertValidSlot,
      runnable: async (channel, now) => {
        if (openOverride !== undefined) return openOverride;
        return this.rows.find((r) => r.channel === channel &&
          (r.status === "AUTHORIZED" || r.status === "CLAIMED") &&
          r.targetPublishSlot.getTime() > now.getTime()) ?? null;
      },
      authorize: async (channel, slot) => {
        const existing = this.rows.find(
          (r) => r.channel === channel && r.targetPublishSlot.getTime() === slot.getTime());
        if (existing) return { cycle: existing, created: false };
        this.writes++;
        const cycle: ProductionCycle = {
          id: `cyc-${++this.seq}`, channel, targetPublishSlot: slot, status: "AUTHORIZED",
          claimantId: null, videoId: null, pipelineRunId: null, failureCode: null,
          authorizedAt: new Date(), claimedAt: null, completedAt: null, failedAt: null,
        };
        this.rows.push(cycle);
        return { cycle, created: true };
      },
    };
  }
}

/** A `now` that sits inside the lead window for MON_SLOT. */
const IN_WINDOW = new Date(MON_SLOT.getTime() - 5 * 60 * 60 * 1000); // 5h before

// ── The enable gate ───────────────────────────────────────────────────────

describe("scheduler enable gate", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["unset", {}, false],
    ["empty", { SCHEDULER_ENABLED: "" }, false],
    ["exact true", { SCHEDULER_ENABLED: "true" }, true],
    ["padded", { SCHEDULER_ENABLED: "  true  " }, true],
    ["TRUE", { SCHEDULER_ENABLED: "TRUE" }, false],
    ["1", { SCHEDULER_ENABLED: "1" }, false],
    ["yes", { SCHEDULER_ENABLED: "yes" }, false],
    ["enabled", { SCHEDULER_ENABLED: "enabled" }, false],
    ["false", { SCHEDULER_ENABLED: "false" }, false],
  ];
  for (const [label, env, expected] of cases) {
    test(`${label} → ${expected ? "enabled" : "DISABLED"}`, () => {
      assert.equal(isSchedulerEnabled(env as NodeJS.ProcessEnv), expected);
    });
  }

  test("disabled scheduler performs ZERO mutation", async () => {
    const store = new FakeStore();
    const r = await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: {} });
    assert.equal(r.outcome, "SKIPPED_DISABLED");
    assert.equal(r.mutated, false);
    assert.equal(store.writes, 0);
    assert.equal(store.rows.length, 0);
  });

  test("a malformed enable value fails closed, not open", async () => {
    const store = new FakeStore();
    // "true " is deliberately absent: it trims to the exact literal and SHOULD
    // arm. Everything here is a value someone might plausibly type meaning yes.
    for (const v of ["TRUE", "True", "1", "yes", "on", "enabled", "  ", "false"]) {
      const r = await schedulerTick(AI, store.deps(MON_SLOT),
        { now: IN_WINDOW, env: { SCHEDULER_ENABLED: v } as NodeJS.ProcessEnv });
      assert.equal(r.outcome, "SKIPPED_DISABLED", `value ${JSON.stringify(v)} must not arm`);
    }
    assert.equal(store.writes, 0);
  });
});

// ── Dry run ───────────────────────────────────────────────────────────────

describe("dry run", () => {
  test("never writes, even when fully armed and in window", async () => {
    const store = new FakeStore();
    const r = await schedulerTick(AI, store.deps(MON_SLOT),
      { now: IN_WINDOW, env: ON, dryRun: true });
    assert.equal(r.outcome, "WOULD_AUTHORIZE");
    assert.equal(r.mutated, false);
    assert.equal(store.writes, 0);
  });

  test("dry run works with the gate disabled, and still writes nothing", async () => {
    const store = new FakeStore();
    const r = await schedulerTick(AI, store.deps(MON_SLOT),
      { now: IN_WINDOW, env: {}, dryRun: true });
    assert.equal(r.outcome, "WOULD_AUTHORIZE");
    assert.equal(store.writes, 0);
  });
});

// ── Idempotency: storms, duplicates, retries ──────────────────────────────

describe("duplicate and repeated ticks", () => {
  test("a duplicate tick authorizes at most once", async () => {
    const store = new FakeStore();
    const a = await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    const b = await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    assert.equal(a.outcome, "AUTHORIZED");
    assert.equal(b.outcome, "SKIPPED_ALREADY_OPEN");
    assert.equal(store.writes, 1);
  });

  test("a scheduler retry after a lost response authorizes at most once", async () => {
    // Models the retry seeing no open cycle (stale read) and calling authorize
    // again: the unique index absorbs it.
    const store = new FakeStore();
    await schedulerTick(AI, store.deps(MON_SLOT, null), { now: IN_WINDOW, env: ON });
    const retry = await schedulerTick(AI, store.deps(MON_SLOT, null), { now: IN_WINDOW, env: ON });
    assert.equal(retry.outcome, "ALREADY_AUTHORIZED");
    assert.equal(retry.mutated, false);
    assert.equal(store.writes, 1);
  });

  test("a 50-tick storm creates exactly one authorization", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 50; i++) {
      await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    }
    assert.equal(store.writes, 1);
    assert.equal(store.rows.length, 1);
  });

  test("a storm across BOTH channels creates one authorization each", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 20; i++) {
      await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
      await schedulerTick(WC, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    }
    assert.equal(store.writes, 2);
    assert.equal(store.rows.filter((r) => r.channel === AI).length, 1);
    assert.equal(store.rows.filter((r) => r.channel === WC).length, 1);
  });
});

// ── The lead window bounds inventory ──────────────────────────────────────

describe("lead window", () => {
  test("too early → no authorization", async () => {
    const store = new FakeStore();
    const early = new Date(MON_SLOT.getTime() - AUTHORIZATION_LEAD_MS - 60_000);
    const r = await schedulerTick(AI, store.deps(MON_SLOT), { now: early, env: ON });
    assert.equal(r.outcome, "SKIPPED_TOO_EARLY");
    assert.equal(store.writes, 0);
  });

  test("a slot beyond the horizon is refused", async () => {
    const store = new FakeStore();
    const farSlot = new Date(MON_SLOT.getTime() + 14 * 86_400_000);
    const r = await schedulerTick(AI, store.deps(farSlot), { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "SKIPPED_TOO_EARLY");
    assert.equal(store.writes, 0);
  });

  test("too late → no authorization, because a retry could not fit", async () => {
    const store = new FakeStore();
    const late = new Date(MON_SLOT.getTime() - MINIMUM_LEAD_MS + 60_000);
    const r = await schedulerTick(AI, store.deps(MON_SLOT), { now: late, env: ON });
    assert.equal(r.outcome, "SKIPPED_TOO_LATE");
    assert.equal(store.writes, 0);
  });

  test("the minimum lead fits a full run plus one retry", () => {
    assert.ok(MINIMUM_LEAD_MS >= PIPELINE_HARD_TIMEOUT_MS * 2,
      "must allow one timed-out run and one complete retry");
  });

  test("the lead window is far wider than the worst observed run", () => {
    // Worst observed LIVE success, audited 2026-08-09: 13.3 min (wet-circuit).
    const worstObservedMs = 13.3 * 60 * 1000;
    assert.ok(AUTHORIZATION_LEAD_MS / worstObservedMs > 10);
  });

  test("inventory is bounded to one: the NEXT slot is never pre-bought", async () => {
    const store = new FakeStore();
    await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    // Wednesday, while Monday is still open. Two guards independently refuse
    // it: the lead window rejects a slot 53h out before the open-cycle check is
    // even reached. Either refusal is correct; accumulating inventory is not.
    const wed = new Date("2026-08-12T19:00:00.000Z");
    const r = await schedulerTick(AI, store.deps(wed), { now: IN_WINDOW, env: ON });
    assert.ok(r.outcome.startsWith("SKIPPED_"), `unexpected ${r.outcome}`);
    assert.equal(r.mutated, false);
    assert.equal(store.writes, 1, "inventory must stay at one");
  });

  test("two valid slots can never both be in the lead window", () => {
    // Why the open-cycle guard is a second line of defence rather than the
    // primary one: consecutive publication slots are at least two days apart,
    // and the lead window is 6h, so the window can only ever contain one slot.
    // Reaching SKIPPED_ALREADY_OPEN therefore means the SAME slot was seen
    // twice — a duplicate tick — which the tests above cover directly.
    let cursor = new Date("2026-08-09T00:00:00Z");
    for (let i = 0; i < 12; i++) {
      const a = nextPublishSlot(cursor);
      const b = nextPublishSlot(new Date(a.getTime() + 1000));
      assert.ok(b.getTime() - a.getTime() > AUTHORIZATION_LEAD_MS,
        `slots ${describeSlot(a)} and ${describeSlot(b)} are closer than the lead window`);
      cursor = new Date(a.getTime() + 1000);
    }
  });
});

// ── Slot correctness, DST, channel awareness ──────────────────────────────

describe("slot policy", () => {
  test("both channels currently share one policy — asserted, not assumed", () => {
    const a = publicationPolicyFor(AI);
    const w = publicationPolicyFor(WC);
    assert.deepEqual(a.days, w.days);
    assert.equal(a.hour, w.hour);
    assert.equal(a.timeZone, w.timeZone);
    assert.deepEqual(a.days, [1, 3, 5]);
    assert.equal(a.hour, 15);
    assert.equal(a.timeZone, TZ);
  });

  test("a wrong weekday is refused for both channels", () => {
    const tue = new Date("2026-08-11T19:00:00.000Z");
    for (const ch of [AI, WC]) {
      assert.throws(() => assertValidSlot(tue, ch),
        (e: unknown) => e instanceof CycleError && e.code === "CYCLE_SLOT_WRONG_DAY");
    }
  });

  test("a wrong local time is refused for both channels", () => {
    const monNoon = new Date("2026-08-10T16:00:00.000Z"); // 12:00 ET
    for (const ch of [AI, WC]) {
      assert.throws(() => assertValidSlot(monNoon, ch),
        (e: unknown) => e instanceof CycleError && e.code === "CYCLE_SLOT_WRONG_TIME");
    }
  });

  test("a scheduler that computes an invalid slot fails closed", async () => {
    const store = new FakeStore();
    const tue = new Date("2026-08-11T19:00:00.000Z");
    const r = await schedulerTick(AI, store.deps(tue), { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "SKIPPED_INVALID_SLOT");
    assert.equal(store.writes, 0);
  });

  test("SUMMER (EDT): the slot is 15:00 local and 19:00Z", () => {
    const s = nextPublishSlot(new Date("2026-08-09T12:00:00Z"));
    const p = zonedParts(s, TZ);
    assert.equal(p.hour, 15);
    assert.equal(s.toISOString(), "2026-08-10T19:00:00.000Z");
    assertValidSlot(s, AI);
  });

  test("WINTER (EST): the slot is still 15:00 local, but 20:00Z", () => {
    const s = nextPublishSlot(new Date("2026-01-04T12:00:00Z")); // Sun Jan 4
    const p = zonedParts(s, TZ);
    assert.equal(p.hour, 15, "local hour must not drift across DST");
    assert.equal(s.toISOString(), "2026-01-05T20:00:00.000Z");
    assertValidSlot(s, AI);
  });

  test("the two DST slots differ in UTC by exactly one hour", () => {
    const summer = nextPublishSlot(new Date("2026-08-09T12:00:00Z"));
    const winter = nextPublishSlot(new Date("2026-01-04T12:00:00Z"));
    assert.equal(zonedParts(summer, TZ).hour, zonedParts(winter, TZ).hour);
    assert.notEqual(summer.getUTCHours(), winter.getUTCHours());
  });

  test("across the spring-forward boundary every slot is still 15:00 local", () => {
    // DST 2026 begins Sun 2026-03-08.
    let cursor = new Date("2026-03-01T12:00:00Z");
    for (let i = 0; i < 8; i++) {
      const s = nextPublishSlot(cursor);
      assert.equal(zonedParts(s, TZ).hour, 15, `slot ${describeSlot(s)} drifted`);
      assert.ok([1, 3, 5].includes(zonedParts(s, TZ).weekday));
      cursor = new Date(s.getTime() + 1000);
    }
  });
});

// ── Channel isolation ─────────────────────────────────────────────────────

describe("channel isolation", () => {
  test("a tick for one channel writes only that channel's row", async () => {
    const store = new FakeStore();
    await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].channel, AI);
  });

  test("an open cycle on one channel does not block the other", async () => {
    const store = new FakeStore();
    await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    const r = await schedulerTick(WC, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "AUTHORIZED");
    assert.equal(store.rows.filter((x) => x.channel === WC).length, 1);
  });

  test("the monitor ticks only its own configured channel", () => {
    assert.match(code(MONITOR), /startAuthorizationTick\(config\.CHANNEL\)/);
    assert.doesNotMatch(code(TICK), /ai-doom-scroll|wet-circuit/);
  });
});

// ── Prior-cycle states ────────────────────────────────────────────────────

describe("prior cycle states", () => {
  const cyc = (over: Partial<ProductionCycle>): ProductionCycle => ({
    id: "prior", channel: AI, targetPublishSlot: MON_SLOT, status: "AUTHORIZED",
    claimantId: null, videoId: null, pipelineRunId: null, failureCode: null,
    authorizedAt: new Date(), claimedAt: null, completedAt: null, failedAt: null, ...over,
  });

  test("a prior AUTHORIZED cycle blocks a new authorization", async () => {
    const store = new FakeStore();
    const r = await schedulerTick(AI, store.deps(MON_SLOT, cyc({})), { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "SKIPPED_ALREADY_OPEN");
    assert.equal(store.writes, 0);
  });

  test("a prior CLAIMED cycle blocks a new authorization — never overridden", async () => {
    const store = new FakeStore();
    const stale = cyc({ status: "CLAIMED", claimantId: "unattended:ai-doom-scroll",
      claimedAt: new Date(IN_WINDOW.getTime() - CLAIM_STALE_AFTER_MS - 60_000) });
    const r = await schedulerTick(AI, store.deps(MON_SLOT, stale), { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "SKIPPED_ALREADY_OPEN");
    assert.equal(store.writes, 0);
  });

  test("the scheduler never reaps, terminalises or reassigns a prior cycle", () => {
    const c = code(SCHED);
    for (const forbidden of ["failAbandonedCycle", "claimCycle", "failCycle",
                             "completeCycle", "UPDATE", "claimantId ="]) {
      assert.ok(!c.includes(forbidden), `scheduler must not contain ${forbidden}`);
    }
  });

  for (const terminal of ["COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"] as const) {
    test(`a prior ${terminal} cycle does NOT block the next valid cycle`, async () => {
      const store = new FakeStore();
      store.rows.push(cyc({ status: terminal, targetPublishSlot: new Date("2026-08-07T19:00:00Z") }));
      const r = await schedulerTick(AI, store.deps(MON_SLOT), { now: IN_WINDOW, env: ON });
      assert.equal(r.outcome, "AUTHORIZED");
    });
  }
});

// ── Blast radius ──────────────────────────────────────────────────────────

describe("blast radius", () => {
  const forbidden: [string, RegExp][] = [
    ["run a pipeline", /runPipeline|runWcCanaryOnce|topicDiscovery|stage/i],
    ["spend narration credits", /elevenlabs|synthesize|reserveCredits|withBudgetWindow/i],
    ["upload", /youtube|videos\.insert|guardedUpload|uploadIntent/i],
    ["advance a pilot", /confirmPilotSlot|completePilot|ProductionPilot|successCount/i],
    ["render", /ffmpeg|videoAssembly|render/i],
  ];
  for (const [what, re] of forbidden) {
    test(`the scheduler cannot ${what}`, () => {
      assert.doesNotMatch(code(SCHED), re);
    });
    test(`the monitor tick cannot ${what}`, () => {
      assert.doesNotMatch(code(TICK), re);
    });
  }

  test("the only table the scheduler can write is production_cycle", () => {
    const c = code(SCHED);
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(c),
      "scheduler issues no SQL of its own — it delegates to authorizeCycle");
  });

  test("the control script's --run is the only mutating mode", () => {
    const c = code(CTRL);
    assert.match(c, /--dry-run/);
    assert.match(c, /dryRun: true/);
  });

  test("the control script is local-only", () => {
    assert.match(CTRL, /const isDirectRun =/);
  });
});

// ── Failure modes fail closed ─────────────────────────────────────────────

describe("failure modes", () => {
  test("a database failure computing the slot fails closed", async () => {
    const deps: SchedulerDeps = {
      nextSlot: async () => { throw new Error("connection refused"); },
      validate: assertValidSlot,
      runnable: async () => null,
      authorize: async () => { throw new Error("must not be reached"); },
    };
    const r = await schedulerTick(AI, deps, { now: IN_WINDOW, env: ON });
    assert.equal(r.outcome, "ERROR");
    assert.equal(r.mutated, false);
  });

  test("the slot is revalidated after generation, not trusted", () => {
    assert.match(code(SCHED), /deps\.validate\(slot, channel\)/);
  });

  test("the enable check precedes every other decision", () => {
    const c = code(SCHED);
    assert.ok(c.indexOf("isSchedulerEnabled") < c.indexOf("deps.nextSlot"));
  });
});
