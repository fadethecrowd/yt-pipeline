import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import {
  SERVICE, PILOT_ID, CHANNEL, LOCK_VALUE, UNLOCK_VALUE, MAX_CAP, RUN_PLAN,
  buildCheckReport, classifyPhase, gatherState, selectedMode,
  doCheck, doArm, doRun, doRelock, doAdvanceCap,
} from "../scripts/ai-doom-pilot-control";
import type { ControlDeps, RunRecord } from "../scripts/ai-doom-pilot-control";

/**
 * The AI Doom pilot control plane.
 *
 * Activating by hand meant six coordinated steps — stage a variable, activate
 * by SQL, remove the lock, watch one run, relock, restore DISABLE_ELEVEN — and
 * a missed one leaves production unlocked. The sequence IS the control, so
 * these tests assert the sequence: which commands, in what order, and what
 * happens when any step fails.
 *
 * Every Railway call, database write and sleep is injected. Nothing here shells
 * out, touches production, or spends anything.
 */

const CONTROL = readFileSync("scripts/ai-doom-pilot-control.ts", "utf8");

const MONDAY_1800 = new Date("2026-08-10T22:00:00Z"); // Mon 18:00 EDT
const SATURDAY_1200 = new Date("2026-08-08T16:00:00Z"); // Sat 12:00 EDT
const TUESDAY_1800 = new Date("2026-08-11T22:00:00Z");

const BASE_PILOT: PilotConfig = {
  id: "row-1", pilotId: PILOT_ID, channel: CHANNEL, channelId: "UCSbJfiA1aobp6G_rgwbHPMw",
  status: "PREPARED", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: null, completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

const GOOD_VARS = {
  PILOT_ID, PIPELINE_MODE: LOCK_VALUE, TEST_STAGE: "PRODUCTION", DISABLE_ELEVEN: "true",
};

interface FakeOpts {
  vars?: Record<string, string>;
  pilot?: PilotConfig | null;
  reserved?: number;
  limits?: { key: string; limit: number }[];
  activeRuns?: number;
  unresolved?: number;
  now?: Date;
  runs?: RunRecord[];
  video?: { id: string; youtubeId: string | null; status: string; scheduledAt: Date | null } | null;
  activateRows?: number;
  capRows?: number;
  setVarsThrowsOn?: (kv: Record<string, string>) => boolean;
  runsSinceThrows?: boolean;
  relockLeavesUnlocked?: boolean;
}

interface Fake {
  deps: ControlDeps;
  calls: string[];
  sets: { kv: Record<string, string>; skipDeploys: boolean }[];
  state: { vars: Record<string, string>; unresolved: number; reserved: number; pilot: PilotConfig | null };
}

function makeFake(o: FakeOpts = {}): Fake {
  const calls: string[] = [];
  const sets: { kv: Record<string, string>; skipDeploys: boolean }[] = [];
  const state = {
    vars: { ...GOOD_VARS, ...(o.vars ?? {}) },
    unresolved: o.unresolved ?? 0,
    reserved: o.reserved ?? 0,
    pilot: o.pilot === undefined ? { ...BASE_PILOT } : o.pilot,
  };
  const deps: ControlDeps = {
    async readVars(s) { calls.push(`readVars:${s}`); return { ...state.vars }; },
    async setVars(s, kv, opts) {
      if (o.setVarsThrowsOn?.(kv)) { calls.push(`setVars:THROW`); throw new Error("railway unavailable"); }
      calls.push(`setVars:${s}:${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(",")}` +
        `:${opts.skipDeploys ? "skip" : "deploy"}`);
      sets.push({ kv, skipDeploys: opts.skipDeploys });
      // A relock that "does not take" leaves the stored values unchanged.
      if (!(o.relockLeavesUnlocked && kv.PIPELINE_MODE === LOCK_VALUE)) {
        Object.assign(state.vars, kv);
      }
    },
    async readPilot() { calls.push("readPilot"); return state.pilot ? { ...state.pilot } : null; },
    async activatePilot() {
      calls.push("activatePilot");
      const rows = o.activateRows ?? 1;
      if (rows === 1 && state.pilot) { state.pilot.status = "ACTIVE"; state.pilot.activatedAt = new Date(); }
      return rows;
    },
    async setMaxSuccesses(_p, _f, to) {
      calls.push(`setMaxSuccesses:${to}`);
      const rows = o.capRows ?? 1;
      if (rows === 1 && state.pilot) state.pilot.maxSuccesses = to;
      return rows;
    },
    async totalReserved() { return state.reserved; },
    async controlledLimits() { return o.limits ?? [{ key: "ai-doom-scroll/PRODUCTION", limit: 0 }]; },
    async activeRunCount() { return o.activeRuns ?? 0; },
    async unresolvedIntentCount() { return state.unresolved; },
    async runsSince() {
      calls.push("runsSince");
      if (o.runsSinceThrows) throw new Error("db unreachable");
      return o.runs ?? [];
    },
    async videoById(id) {
      calls.push("videoById");
      return o.video === undefined
        ? { id, youtubeId: "vid123", status: "UPLOADED", scheduledAt: null }
        : o.video;
    },
    now: () => o.now ?? MONDAY_1800,
    async sleep() { calls.push("sleep"); },
    log: () => {},
  };
  return { deps, calls, sets, state };
}

const terminalRun = (status: string): RunRecord => ({
  id: "run-1", channel: CHANNEL, status,
  startTime: new Date("2026-08-10T22:01:00Z"), endTime: new Date("2026-08-10T22:20:00Z"),
});

// ── CHECK ────────────────────────────────────────────────────────────────

describe("CHECK", () => {
  test("1. Saturday is statically ready but window-ineligible", async () => {
    const f = makeFake({ now: SATURDAY_1200 });
    const r = await doCheck(f.deps);
    assert.equal(r.staticReady, true, "configuration is correct on a Saturday");
    assert.equal(r.window.allowed, false, "but it may not run today");
    assert.equal(r.phase, "PREPARED_FOR_ARM");
    // The window must not drag static readiness down.
    assert.ok(r.checks.every((c) => c.ok));
  });

  test("CHECK mutates nothing", async () => {
    const f = makeFake();
    await doCheck(f.deps);
    assert.ok(!f.calls.some((c) => c.startsWith("setVars")));
    assert.ok(!f.calls.includes("activatePilot"));
    assert.ok(!f.calls.some((c) => c.startsWith("setMaxSuccesses")));
  });

  test("2. missing PILOT_ID fails static readiness", async () => {
    const f = makeFake({ vars: { PILOT_ID: "" } });
    const r = await doCheck(f.deps);
    assert.equal(r.staticReady, false);
    assert.equal(r.phase, "CONFIG_INVALID");
  });

  test("3. wrong PILOT_ID fails", async () => {
    const r = buildCheckReport(await gatherState(makeFake({ vars: { PILOT_ID: "some-other-pilot" } }).deps));
    assert.equal(r.staticReady, false);
    assert.equal(r.phase, "CONFIG_INVALID");
  });

  test("4. TEST_STAGE != PRODUCTION fails", async () => {
    const r = buildCheckReport(await gatherState(makeFake({ vars: { TEST_STAGE: "DIAGNOSTIC" } }).deps));
    assert.equal(r.staticReady, false);
  });

  test("5. an active run is reported as RUN_IN_PROGRESS", async () => {
    const r = buildCheckReport(await gatherState(makeFake({ activeRuns: 1 }).deps));
    assert.equal(r.phase, "RUN_IN_PROGRESS");
    assert.equal(r.staticReady, false);
  });

  test("6. an unresolved intent demands reconciliation", async () => {
    const r = buildCheckReport(await gatherState(makeFake({ unresolved: 2 }).deps));
    assert.equal(r.phase, "RECONCILIATION_REQUIRED");
  });

  test("7. a nonzero reservation or unlocked budget fails", async () => {
    assert.equal(buildCheckReport(await gatherState(makeFake({ reserved: 500 }).deps)).staticReady, false);
    assert.equal(buildCheckReport(await gatherState(
      makeFake({ limits: [{ key: "ai-doom-scroll/PRODUCTION", limit: 4000 }] }).deps)).staticReady, false);
  });

  test("phases are precise, never a vague ready", async () => {
    const armed = { ...BASE_PILOT, status: "ACTIVE" as const, activatedAt: new Date() };
    assert.equal(classifyPhase(await gatherState(makeFake({ pilot: armed }).deps)), "ARMED_FOR_RUN");
    assert.equal(classifyPhase(await gatherState(makeFake({
      pilot: { ...armed, successCount: 1, successVideoIds: ["v1"] } }).deps)),
      "CAP_EXHAUSTED_REVIEW_REQUIRED");
    assert.equal(classifyPhase(await gatherState(makeFake({
      pilot: { ...armed, successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] } }).deps)),
      "PILOT_COMPLETE");
    assert.equal(classifyPhase(await gatherState(makeFake({ pilot: null }).deps)), "PILOT_MISSING");
  });

  test("no mode is inferred from a missing flag", () => {
    assert.equal(selectedMode(["node", "x"]), "CHECK");
    assert.equal(selectedMode(["node", "x", "--arm"]), "ARM");
    assert.equal(selectedMode(["node", "x", "--arm", "--run"]), "AMBIGUOUS");
  });
});

// ── ARM ──────────────────────────────────────────────────────────────────

describe("ARM", () => {
  test("without its acknowledgement flag it refuses", async () => {
    const f = makeFake();
    const r = await doArm(f.deps, false);
    assert.equal(r.armed, false);
    assert.ok(!f.calls.includes("activatePilot"));
  });

  test("8. PREPARED 0/1 inside the window performs exactly one activation", async () => {
    const f = makeFake();
    const r = await doArm(f.deps, true);
    assert.equal(r.armed, true);
    assert.equal(r.rowsAffected, 1);
    assert.equal(f.calls.filter((c) => c === "activatePilot").length, 1);
  });

  test("ARM changes no Railway variable and starts nothing", async () => {
    const f = makeFake();
    await doArm(f.deps, true);
    assert.equal(f.sets.length, 0, "ARM must not touch Railway");
  });

  test("9. outside the window it mutates nothing", async () => {
    for (const now of [SATURDAY_1200, TUESDAY_1800]) {
      const f = makeFake({ now });
      const r = await doArm(f.deps, true);
      assert.equal(r.armed, false);
      assert.match(r.reason, /outside the execution window/);
      assert.ok(!f.calls.includes("activatePilot"));
    }
  });

  test("10. a 0/3 pilot refuses the first ARM", async () => {
    // Progressive review must be established before anything runs.
    const f = makeFake({ pilot: { ...BASE_PILOT, maxSuccesses: 3 } });
    const r = await doArm(f.deps, true);
    assert.equal(r.armed, false);
    assert.match(r.reason, /maxSuccesses is 3/);
    assert.ok(!f.calls.includes("activatePilot"));
  });

  test("11. a compare-and-set matching zero rows fails", async () => {
    const f = makeFake({ activateRows: 0 });
    const r = await doArm(f.deps, true);
    assert.equal(r.armed, false);
    assert.match(r.reason, /matched 0 rows/);
  });

  test("an already ACTIVE pilot is not re-armed", async () => {
    const f = makeFake({ pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date() } });
    const r = await doArm(f.deps, true);
    assert.equal(r.armed, false);
    assert.match(r.reason, /expected PREPARED_FOR_ARM/);
  });
});

// ── RUN ──────────────────────────────────────────────────────────────────

const armedFake = (o: FakeOpts = {}) => makeFake({
  pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date("2026-08-10T21:00:00Z") },
  ...o,
});

describe("RUN orchestration", () => {
  test("without its acknowledgement flag it refuses before touching anything", async () => {
    const f = armedFake();
    const r = await doRun(f.deps, false);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.sets.length, 0);
  });

  test("12/13/14/15. exact order: stage narration, verify, unlock LAST, one start", async () => {
    const f = armedFake({
      runs: [terminalRun("SUCCESS")],
      pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(), successCount: 0 },
    });
    // Pilot claims its slot during the run.
    const orig = f.deps.readPilot.bind(f.deps);
    let reads = 0;
    f.deps.readPilot = async () => {
      reads++;
      const p = await orig(PILOT_ID);
      return reads > 1 && p ? { ...p, successCount: 1, successVideoIds: ["v1"] } : p;
    };

    const r = await doRun(f.deps, true);

    // 13: DISABLE_ELEVEN=false staged first, with --skip-deploys.
    assert.deepEqual(f.sets[0], { kv: { DISABLE_ELEVEN: "false" }, skipDeploys: true });
    // 14: PIPELINE_MODE removed LAST of the preparatory steps.
    assert.deepEqual(f.sets[1], { kv: { PIPELINE_MODE: UNLOCK_VALUE }, skipDeploys: false });
    // 15: exactly one unlock — one production start.
    assert.equal(f.sets.filter((s) => s.kv.PIPELINE_MODE === UNLOCK_VALUE).length, 1);
    // 16: relock afterwards.
    assert.deepEqual(f.sets[2], {
      kv: { PIPELINE_MODE: LOCK_VALUE, DISABLE_ELEVEN: "true" }, skipDeploys: false,
    });
    assert.equal(f.sets.length, 3, "no other Railway mutation");
    assert.equal(r.outcome, "SUCCESS");
    assert.equal(r.relocked, true);
    assert.deepEqual(r.steps, [...RUN_PLAN]);
  });

  test("the unlock never precedes the narration stage", async () => {
    const f = armedFake({ runs: [terminalRun("SUCCESS")] });
    await doRun(f.deps, true);
    const stageIdx = f.sets.findIndex((s) => "DISABLE_ELEVEN" in s.kv && s.kv.DISABLE_ELEVEN === "false");
    const unlockIdx = f.sets.findIndex((s) => s.kv.PIPELINE_MODE === UNLOCK_VALUE);
    assert.ok(stageIdx >= 0 && unlockIdx > stageIdx);
  });

  test("staging that silently removed the lock aborts before unlocking", async () => {
    const f = armedFake({ runs: [terminalRun("SUCCESS")] });
    const realSet = f.deps.setVars.bind(f.deps);
    f.deps.setVars = async (s, kv, o) => {
      await realSet(s, kv, o);
      if (kv.DISABLE_ELEVEN === "false") f.state.vars.PIPELINE_MODE = "somethingelse";
    };
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "REFUSED");
    assert.ok(!f.sets.some((x) => x.kv.PIPELINE_MODE === UNLOCK_VALUE));
  });

  test("16. terminal success relocks", async () => {
    const f = armedFake({ runs: [terminalRun("SUCCESS")] });
    const r = await doRun(f.deps, true);
    assert.equal(r.relocked, true);
    assert.equal(f.state.vars.PIPELINE_MODE, LOCK_VALUE);
    assert.equal(f.state.vars.DISABLE_ELEVEN, "true");
  });

  test("17. terminal failure relocks", async () => {
    const f = armedFake({ runs: [terminalRun("FAILED")] });
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "FAILED_BEFORE_SPEND");
    assert.equal(r.relocked, true);
    assert.equal(f.state.vars.PIPELINE_MODE, LOCK_VALUE);
  });

  test("18. a QA failure produces no retry", async () => {
    const f = armedFake({ runs: [terminalRun("FAILED")] });
    const r = await doRun(f.deps, true);
    assert.equal(f.sets.filter((s) => s.kv.PIPELINE_MODE === UNLOCK_VALUE).length, 1,
      "exactly one unlock — never a second attempt");
    assert.notEqual(r.outcome, "SUCCESS");
  });

  test("19. an upload intent left open BY the run is ambiguous, never retried", async () => {
    // It must start clean — a pre-existing intent is refused at pre-flight
    // instead, which is a different (already covered) case. This models the
    // intent appearing during the run.
    const f = armedFake({ runs: [terminalRun("SUCCESS")] });
    const realSet = f.deps.setVars.bind(f.deps);
    f.deps.setVars = async (s, kv, o) => {
      await realSet(s, kv, o);
      if (kv.PIPELINE_MODE === UNLOCK_VALUE) f.state.unresolved = 1;
    };
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "UPLOAD_AMBIGUOUS");
    assert.match(r.reason, /reconcile before any retry/);
    assert.equal(r.relocked, true);
    assert.equal(f.sets.filter((s) => s.kv.PIPELINE_MODE === UNLOCK_VALUE).length, 1);
  });

  test("a reservation left open BY the run is FAILED_AFTER_RESERVATION", async () => {
    const f = armedFake({ runs: [terminalRun("FAILED")] });
    const realSet = f.deps.setVars.bind(f.deps);
    f.deps.setVars = async (s, kv, o) => {
      await realSet(s, kv, o);
      if (kv.PIPELINE_MODE === UNLOCK_VALUE) f.state.reserved = 4000;
    };
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "FAILED_AFTER_RESERVATION");
    assert.match(r.reason, /settle before any retry/);
    assert.equal(r.relocked, true);
  });

  test("20. an observation exception still relocks", async () => {
    const f = armedFake({ runsSinceThrows: true });
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "OBSERVATION_FAILED");
    assert.equal(r.relocked, true, "the finally block must still relock");
    assert.equal(f.state.vars.PIPELINE_MODE, LOCK_VALUE);
  });

  test("21. a relock that does not take is surfaced, not hidden", async () => {
    const f = armedFake({ runs: [terminalRun("SUCCESS")], relockLeavesUnlocked: true });
    const r = await doRun(f.deps, true);
    assert.equal(r.relocked, false);
    assert.ok(r.relockError && r.relockError.length > 0);
  });

  test("21b. a relock that throws is surfaced", async () => {
    const f = armedFake({
      runs: [terminalRun("SUCCESS")],
      setVarsThrowsOn: (kv) => kv.PIPELINE_MODE === LOCK_VALUE,
    });
    const r = await doRun(f.deps, true);
    assert.equal(r.relocked, false);
    assert.match(r.relockError!, /railway unavailable/);
  });

  test("22. an exhausted cap refuses a second run", async () => {
    const f = armedFake({
      pilot: {
        ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(),
        successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"],
      },
    });
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "REFUSED");
    assert.match(r.reason, /CAP_EXHAUSTED_REVIEW_REQUIRED/);
    assert.equal(f.sets.length, 0, "nothing unlocked");
  });

  test("outside the window RUN refuses and touches nothing", async () => {
    const f = armedFake({ now: SATURDAY_1200, runs: [terminalRun("SUCCESS")] });
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.sets.length, 0);
  });

  test("a PREPARED pilot cannot be RUN", async () => {
    const f = makeFake();
    const r = await doRun(f.deps, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.sets.length, 0);
  });
});

// ── RELOCK ───────────────────────────────────────────────────────────────

describe("RELOCK", () => {
  test("23. sets the lock and re-disables narration in one invocation", async () => {
    const f = makeFake({ vars: { PIPELINE_MODE: UNLOCK_VALUE, DISABLE_ELEVEN: "false" } });
    const r = await doRelock(f.deps);
    assert.equal(r.relocked, true);
    assert.equal(f.sets.length, 1, "one invocation, one restart");
    assert.deepEqual(f.sets[0].kv, { PIPELINE_MODE: LOCK_VALUE, DISABLE_ELEVEN: "true" });
    assert.equal(f.sets[0].skipDeploys, false);
  });

  test("23b. it targets only yt-pipeline", async () => {
    const f = makeFake({ vars: { PIPELINE_MODE: UNLOCK_VALUE } });
    await doRelock(f.deps);
    assert.ok(f.calls.some((c) => c.startsWith(`setVars:${SERVICE}:`)));
    assert.ok(!f.calls.some((c) => c.includes("wc-pipeline")));
  });

  test("24. it never touches the pilot or the cap", async () => {
    const f = makeFake({ vars: { PIPELINE_MODE: UNLOCK_VALUE } });
    await doRelock(f.deps);
    assert.ok(!f.calls.includes("activatePilot"));
    assert.ok(!f.calls.some((c) => c.startsWith("setMaxSuccesses")));
  });

  test("it reports runs that were active when relock was requested", async () => {
    const f = makeFake({ activeRuns: 1, vars: { PIPELINE_MODE: UNLOCK_VALUE } });
    const r = await doRelock(f.deps);
    assert.equal(r.activeRunsAtRequest, 1);
  });

  test("a relock that does not take is reported false", async () => {
    const f = makeFake({ vars: { PIPELINE_MODE: UNLOCK_VALUE }, relockLeavesUnlocked: true });
    const r = await doRelock(f.deps);
    assert.equal(r.relocked, false);
  });
});

// ── ADVANCE CAP ──────────────────────────────────────────────────────────

const reviewed = (over: Partial<PilotConfig>) => makeFake({
  pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(), ...over },
});

describe("ADVANCE CAP", () => {
  test("25. 1/1 with human approval becomes 1/2", async () => {
    const f = reviewed({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, true);
    assert.deepEqual([r.from, r.to], [1, 2]);
    assert.ok(f.calls.includes("setMaxSuccesses:2"));
  });

  test("26. 2/2 with human approval becomes 2/3", async () => {
    const f = reviewed({ successCount: 2, maxSuccesses: 2, successVideoIds: ["v1", "v2"] });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, true);
    assert.deepEqual([r.from, r.to], [2, 3]);
  });

  test("the cap can never exceed the maximum", async () => {
    const f = reviewed({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, false);
    assert.equal(MAX_CAP, 3);
  });

  test("27. an unexhausted cap refuses", async () => {
    const f = reviewed({ successCount: 0, maxSuccesses: 1 });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, false);
    assert.match(r.reason, /not exhausted/);
    assert.ok(!f.calls.some((c) => c.startsWith("setMaxSuccesses")));
  });

  test("28. a successVideoIds mismatch refuses", async () => {
    const f = reviewed({ successCount: 1, maxSuccesses: 1, successVideoIds: [] });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, false);
    assert.match(r.reason, /reconcile first/);
  });

  test("29. an unresolved intent refuses", async () => {
    const f = makeFake({
      pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(), successCount: 1, successVideoIds: ["v1"] },
      unresolved: 1,
    });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, false);
  });

  test("30. a service that is not locked refuses", async () => {
    const f = makeFake({
      pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(), successCount: 1, successVideoIds: ["v1"] },
      vars: { PIPELINE_MODE: UNLOCK_VALUE },
    });
    const r = await doAdvanceCap(f.deps, true);
    assert.equal(r.advanced, false);
    assert.match(r.reason, /not locked/);
  });

  test("the previous video must really exist, be uploaded and unscheduled", async () => {
    const base = { successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] };
    for (const video of [
      null,
      { id: "v1", youtubeId: null, status: "UPLOADED", scheduledAt: null },
      { id: "v1", youtubeId: "y", status: "FAILED", scheduledAt: null },
      { id: "v1", youtubeId: "y", status: "UPLOADED", scheduledAt: new Date() },
    ]) {
      const f = makeFake({
        pilot: { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date(), ...base },
        video: video as never,
      });
      const r = await doAdvanceCap(f.deps, true);
      assert.equal(r.advanced, false, `video ${JSON.stringify(video)} must refuse`);
    }
  });

  test("without human acknowledgement it refuses", async () => {
    const f = reviewed({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] });
    const r = await doAdvanceCap(f.deps, false);
    assert.equal(r.advanced, false);
    assert.ok(!f.calls.some((c) => c.startsWith("setMaxSuccesses")));
  });

  test("31. advancing never starts a run", async () => {
    const f = reviewed({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] });
    await doAdvanceCap(f.deps, true);
    assert.equal(f.sets.length, 0, "no Railway mutation, so no start");
  });

  test("10. the progression 0/1 → 1/2 → 2/3 grants one slot at a time", async () => {
    let pilot: PilotConfig = { ...BASE_PILOT, status: "ACTIVE", activatedAt: new Date() };
    const seen: string[] = [];
    for (const step of [1, 2] as const) {
      pilot = { ...pilot, successCount: step, maxSuccesses: step,
        successVideoIds: Array.from({ length: step }, (_, i) => `v${i + 1}`) };
      const f = makeFake({ pilot });
      const before = classifyPhase(await gatherState(f.deps));
      const r = await doAdvanceCap(f.deps, true);
      seen.push(`${before}->${r.from}/${r.to}`);
      assert.equal(r.advanced, true);
      pilot = { ...pilot, maxSuccesses: r.to };
      // Exactly one slot is now free.
      assert.equal(pilot.maxSuccesses - pilot.successCount, 1);
    }
    assert.deepEqual(seen, [
      "CAP_EXHAUSTED_REVIEW_REQUIRED->1/2",
      "CAP_EXHAUSTED_REVIEW_REQUIRED->2/3",
    ]);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────

describe("isolation", () => {
  test("32. Wet Circuit is never referenced", () => {
    assert.ok(!CONTROL.includes("wet-circuit"));
    assert.ok(!CONTROL.includes("wc-pipeline"));
    assert.ok(!CONTROL.includes("wc-canary"));
  });

  test("33. monitors are never referenced", () => {
    assert.ok(!CONTROL.includes("monitor-ai-doom"));
    assert.ok(!CONTROL.includes("monitor-wc"));
    assert.ok(!CONTROL.includes("MONITOR_AI_ENABLED"));
  });

  test("34. nothing under src/ imports this script", () => {
    for (const f of ["src/index.ts", "src/pipeline.ts", "src/pilotBinding.ts"]) {
      assert.ok(!readFileSync(f, "utf8").includes("ai-doom-pilot-control"),
        `${f} must not import the control tool`);
    }
  });

  test("35. importing the module runs nothing", () => {
    assert.match(CONTROL, /const isDirectRun =/);
    assert.match(CONTROL, /if \(isDirectRun\) \{/);
  });

  test("only yt-pipeline is ever targeted", () => {
    assert.match(CONTROL, /export const SERVICE = "yt-pipeline"/);
    const setCalls = [...CONTROL.matchAll(/setVars\(\s*SERVICE/g)];
    assert.ok(setCalls.length >= 3, "all mutations go through the SERVICE constant");
  });

  test("every mutating mode requires an explicit acknowledgement", () => {
    assert.match(CONTROL, /--i-understand-this-activates-the-pilot/);
    assert.match(CONTROL, /--i-understand-this-spends-credits/);
    assert.match(CONTROL, /--i-have-reviewed-the-previous-video/);
  });
});
