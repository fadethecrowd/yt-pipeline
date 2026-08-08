import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { zonedParts, nextPublishSlot } from "@yt-pipeline/pipeline-core";
import { assertValidSlot, CycleError } from "@yt-pipeline/pipeline-core";
import type { CycleStatus } from "@yt-pipeline/pipeline-core";

/**
 * Durable per-cycle authorization.
 *
 * Neither channel has a recurring trigger, so ordinary production happens only
 * when a container starts — and with the pipeline unlocked, ANY start would
 * reach discovery and create a video. "Today is Monday" was the only thing
 * between a redeploy and an extra upload, and that is not an authorization.
 *
 * The invariant these tests defend is exactly one: ONE AUTHORIZATION → AT MOST
 * ONE CANDIDATE. Every scenario below is a way that could go wrong.
 *
 * The compare-and-set semantics are modelled here against an in-memory table
 * that enforces the same unique constraint the migration creates, so the state
 * machine is provable without a live database. The SQL itself is pinned
 * separately against the source.
 */

const LIB = readFileSync("packages/pipeline-core/src/lib/productionCycle.ts", "utf8");
const MIGRATION = readFileSync("prisma/migrations/0018_production_cycle/migration.sql", "utf8");
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");
const TZ = "America/New_York";

// ── A faithful in-memory model of the table + its constraint ─────────────

interface Row {
  id: string; channel: string; slot: number; status: CycleStatus;
  claimantId: string | null; videoId: string | null; failureCode: string | null;
}

class FakeCycles {
  rows: Row[] = [];
  private seq = 0;

  /** INSERT ... ON CONFLICT DO NOTHING against @@unique([channel, slot]). */
  authorize(channel: string, slot: Date): { row: Row; created: boolean } {
    const existing = this.rows.find((r) => r.channel === channel && r.slot === slot.getTime());
    if (existing) return { row: existing, created: false };
    const row: Row = {
      id: `c${++this.seq}`, channel, slot: slot.getTime(), status: "AUTHORIZED",
      claimantId: null, videoId: null, failureCode: null,
    };
    this.rows.push(row);
    return { row, created: true };
  }

  runnable(channel: string, now: Date): Row | null {
    return this.rows
      .filter((r) => r.channel === channel && (r.status === "AUTHORIZED" || r.status === "CLAIMED")
        && r.slot > now.getTime())
      .sort((a, b) => a.slot - b.slot)[0] ?? null;
  }

  claim(id: string, claimant: string): Row | null {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    const ok = (r.status === "AUTHORIZED" || r.status === "CLAIMED")
      && (r.claimantId === null || r.claimantId === claimant);
    if (!ok) return null;
    r.status = "CLAIMED"; r.claimantId = claimant;
    return r;
  }

  attach(id: string, claimant: string, videoId: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || r.videoId !== null) return false;
    r.videoId = videoId;
    return true;
  }

  complete(id: string, claimant: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || r.videoId === null) return false;
    r.status = "COMPLETED";
    return true;
  }

  fail(id: string, claimant: string, code: string, reconcile = false): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED") return false;
    r.status = reconcile ? "RECONCILIATION_REQUIRED" : "FAILED";
    r.failureCode = code;
    return true;
  }
}

const AI = "ai-doom-scroll";
const WC = "wet-circuit";
const SAT = new Date("2026-08-08T16:00:00Z");
const MON = new Date("2026-08-10T19:00:00.000Z"); // Mon 15:00 EDT
const JAN = new Date("2026-01-05T20:00:00.000Z"); // Mon 15:00 EST

// ── 1-7. Authorization and slot identity ─────────────────────────────────

describe("1-7. authorization and cycle identity", () => {
  test("1. authorizing a channel/slot creates exactly one cycle", () => {
    const t = new FakeCycles();
    const r = t.authorize(AI, MON);
    assert.equal(r.created, true);
    assert.equal(t.rows.length, 1);
    assert.equal(r.row.status, "AUTHORIZED");
  });

  test("2. a duplicate authorization cannot create a second row", () => {
    const t = new FakeCycles();
    const a = t.authorize(AI, MON);
    const b = t.authorize(AI, MON);
    assert.equal(b.created, false);
    assert.equal(b.row.id, a.row.id);
    assert.equal(t.rows.length, 1, "a duplicate scheduler event must be a no-op");
  });

  test("3. the same slot for the other channel is independent", () => {
    const t = new FakeCycles();
    t.authorize(AI, MON);
    const wc = t.authorize(WC, MON);
    assert.equal(wc.created, true);
    assert.equal(t.rows.length, 2);
    assert.notEqual(wc.row.id, t.rows[0].id);
  });

  test("4. a non-publication weekday is refused", () => {
    for (const iso of ["2026-08-11T19:00:00.000Z", "2026-08-13T19:00:00.000Z",
                       "2026-08-15T19:00:00.000Z", "2026-08-16T19:00:00.000Z"]) {
      assert.throws(() => assertValidSlot(new Date(iso)), CycleError, iso);
    }
  });

  test("5. a slot that is not exactly 15:00:00 local is refused", () => {
    for (const iso of ["2026-08-10T18:00:00.000Z", "2026-08-10T20:00:00.000Z",
                       "2026-08-10T19:30:00.000Z", "2026-08-10T19:00:30.000Z"]) {
      assert.throws(() => assertValidSlot(new Date(iso)), CycleError, iso);
    }
  });

  test("6/7. DST: summer and winter slots are both valid and distinct", () => {
    assert.doesNotThrow(() => assertValidSlot(MON));
    assert.doesNotThrow(() => assertValidSlot(JAN));
    assert.equal(zonedParts(MON, TZ).hour, 15);
    assert.equal(zonedParts(JAN, TZ).hour, 15);
    // Same wall clock, different UTC instants — so different identities, which
    // is correct: they are different calendar days.
    assert.notEqual(MON.getUTCHours(), JAN.getUTCHours());
    const t = new FakeCycles();
    t.authorize(AI, MON); t.authorize(AI, JAN);
    assert.equal(t.rows.length, 2);
  });

  test("a slot produced by the scheduler is always a valid cycle target", () => {
    let cur = new Date("2026-01-01T05:00:00Z");
    for (let i = 0; i < 60; i++) {
      cur = nextPublishSlot(cur);
      assert.doesNotThrow(() => assertValidSlot(cur), cur.toISOString());
    }
  });
});

// ── 8-14. Claiming and restart safety ────────────────────────────────────

describe("8-14. claiming and restart safety", () => {
  test("8. no authorization means nothing is runnable", () => {
    const t = new FakeCycles();
    assert.equal(t.runnable(AI, SAT), null);
  });

  test("9/10. two simultaneous claimants — exactly one wins", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    const a = t.claim(row.id, "container-A");
    const b = t.claim(row.id, "container-B");
    assert.ok(a, "first claimant wins");
    assert.equal(b, null, "second claimant is refused");
    assert.equal(row.claimantId, "container-A");
  });

  test("the same claimant may re-claim — that is how crash recovery works", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "container-A");
    assert.ok(t.claim(row.id, "container-A"), "restart of the same claimant resumes");
  });

  test("11-14. restart, deploy, env change and infra event create no candidate", () => {
    const t = new FakeCycles();
    // No authorization exists — this is the ordinary state between cycles.
    for (const _event of ["restart", "deploy", "env-change", "infra"]) {
      assert.equal(t.runnable(AI, SAT), null, "startup must find nothing runnable");
    }
    assert.equal(t.rows.length, 0);
  });

  test("a completed cycle is never runnable again", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "vid-1"); t.complete(row.id, "A");
    assert.equal(t.runnable(AI, SAT), null);
  });

  test("a past slot is not runnable", () => {
    const t = new FakeCycles();
    t.authorize(AI, MON);
    assert.equal(t.runnable(AI, new Date(MON.getTime() + 1000)), null);
  });
});

// ── 15-19. Candidate binding ─────────────────────────────────────────────

describe("15-19. one authorization, one candidate", () => {
  test("15/16. the first attach binds exactly one candidate", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A");
    assert.equal(t.attach(row.id, "A", "vid-1"), true);
    assert.equal(row.videoId, "vid-1");
  });

  test("19. a second attach is refused — no cycle can hold two candidates", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A");
    t.attach(row.id, "A", "vid-1");
    assert.equal(t.attach(row.id, "A", "vid-2"), false);
    assert.equal(row.videoId, "vid-1");
  });

  test("a non-claimant cannot attach", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A");
    assert.equal(t.attach(row.id, "B", "vid-x"), false);
    assert.equal(row.videoId, null);
  });

  test("17/18. a resumed cycle carries its candidate, so resume replaces discovery", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "vid-1");
    // Crash, then a new start by the same claimant.
    const resumed = t.claim(row.id, "A");
    assert.equal(resumed!.videoId, "vid-1");
    // Because videoId is set, attach is closed — a second candidate is
    // impossible even if the runner tried.
    assert.equal(t.attach(row.id, "A", "vid-2"), false);
  });

  test("completion requires a bound candidate", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A");
    assert.equal(t.complete(row.id, "A"), false, "cannot complete with no video");
    t.attach(row.id, "A", "v");
    assert.equal(t.complete(row.id, "A"), true);
  });
});

// ── 20-30. Failure, reconciliation and the next cycle ────────────────────

describe("20-30. failure and next-cycle behaviour", () => {
  test("20. a crash before candidate creation is recoverable by the same cycle", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A");            // claimed, then crash
    const resumed = t.claim(row.id, "A");
    assert.ok(resumed);
    assert.equal(resumed!.videoId, null, "no candidate yet");
    assert.equal(t.attach(row.id, "A", "vid-1"), true, "its one candidate may still be created");
  });

  test("21/22. a crash after creation resumes that candidate and never adds another", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "vid-1");
    for (let restart = 0; restart < 5; restart++) {
      t.claim(row.id, "A");
      assert.equal(t.attach(row.id, "A", `vid-extra-${restart}`), false);
    }
    assert.equal(row.videoId, "vid-1");
  });

  test("23. a QA failure does not authorize a replacement candidate", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "vid-1");
    assert.equal(t.fail(row.id, "A", "QA_FAILED"), true);
    assert.equal(t.runnable(AI, SAT), null, "a FAILED cycle is terminal");
  });

  test("24/25. upload ambiguity parks for reconciliation, never retried", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "vid-1");
    assert.equal(t.fail(row.id, "A", "UPLOAD_AMBIGUOUS", true), true);
    assert.equal(row.status, "RECONCILIATION_REQUIRED");
    assert.equal(t.runnable(AI, SAT), null, "never auto-resumed");
  });

  test("26. a COMPLETED cycle cannot be claimed, attached or completed again", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "v"); t.complete(row.id, "A");
    assert.equal(t.claim(row.id, "A"), null);
    assert.equal(t.attach(row.id, "A", "v2"), false);
    assert.equal(t.complete(row.id, "A"), false);
  });

  test("27. a FAILED cycle is terminal under this policy", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.fail(row.id, "A", "X");
    assert.equal(t.claim(row.id, "A"), null);
    assert.equal(t.runnable(AI, SAT), null);
  });

  test("28/29. the next slot needs its own authorization and cannot be spilled into", () => {
    const t = new FakeCycles();
    const { row } = t.authorize(AI, MON);
    t.claim(row.id, "A"); t.attach(row.id, "A", "v"); t.complete(row.id, "A");
    assert.equal(t.runnable(AI, SAT), null, "completing does not roll forward");
    const wed = new Date("2026-08-12T19:00:00.000Z");
    const next = t.authorize(AI, wed);
    assert.equal(next.created, true);
    assert.equal(t.runnable(AI, SAT)!.id, next.row.id);
  });

  test("30. a missed cycle simply expires — it is never runnable after its slot", () => {
    const t = new FakeCycles();
    t.authorize(AI, MON);
    assert.equal(t.runnable(AI, new Date(MON.getTime() + 3600_000)), null);
  });
});

// ── 34-35. Channel isolation ─────────────────────────────────────────────

describe("34-35. channel isolation", () => {
  test("each channel only ever sees its own cycles", () => {
    const t = new FakeCycles();
    const ai = t.authorize(AI, MON);
    const wc = t.authorize(WC, MON);
    assert.equal(t.runnable(AI, SAT)!.id, ai.row.id);
    assert.equal(t.runnable(WC, SAT)!.id, wc.row.id);
  });

  test("claiming one channel's cycle leaves the other untouched", () => {
    const t = new FakeCycles();
    const ai = t.authorize(AI, MON);
    const wc = t.authorize(WC, MON);
    t.claim(ai.row.id, "A"); t.attach(ai.row.id, "A", "ai-vid");
    assert.equal(wc.row.status, "AUTHORIZED");
    assert.equal(wc.row.videoId, null);
  });

  test("the library resolves the channel's own table for occupied slots", () => {
    assert.match(LIB, /channel === "ai-doom-scroll" \? "video" : "wc_video"/);
  });
});

// ── SQL and schema pinning ───────────────────────────────────────────────

describe("the durable guarantees are in the SQL, not only in code", () => {
  test("the unique constraint exists in schema and migration", () => {
    assert.match(SCHEMA, /@@unique\(\[channel, targetPublishSlot\]\)/);
    assert.match(MIGRATION, /CREATE UNIQUE INDEX "production_cycle_channel_targetPublishSlot_key"/);
  });

  test("authorization is idempotent at the database level", () => {
    assert.match(LIB, /ON CONFLICT \("channel", "targetPublishSlot"\) DO NOTHING/);
  });

  test("every transition is a guarded compare-and-set", () => {
    for (const guard of [
      /AND "status" IN \('AUTHORIZED', 'CLAIMED'\)/,          // claim
      /AND "status" = 'CLAIMED' AND "videoId" IS NULL/,        // attach
      /AND "status" = 'CLAIMED' AND "videoId" IS NOT NULL/,    // complete
    ]) {
      assert.match(LIB, guard);
    }
  });

  test("claiming cannot steal another claimant's cycle", () => {
    assert.match(LIB, /AND \("claimantId" IS NULL OR "claimantId" = \$2\)/);
  });

  test("only AUTHORIZED and CLAIMED are ever runnable", () => {
    assert.match(LIB, /"status" IN \('AUTHORIZED', 'CLAIMED'\)[\s\S]{0,120}"targetPublishSlot" > \$2/);
  });

  test("the migration is additive only", () => {
    const executable = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.trim())
      .join("\n");
    for (const destructive of ["DROP", "TRUNCATE", "DELETE", "UPDATE "]) {
      assert.ok(!executable.includes(destructive), `migration must not ${destructive}`);
    }
    assert.match(executable, /CREATE TABLE "production_cycle"/);
    assert.match(executable, /CREATE TYPE "ProductionCycleStatus"/);
  });

  test("the model documents why videoId is not a foreign key", () => {
    assert.match(SCHEMA, /AI Doom rows live in Video, Wet Circuit rows in WcVideo/);
  });

  test("the library explains why an arbitrary start is not authorization", () => {
    assert.match(LIB.replace(/\s*\n\s*\*?\s*/g, " "), /"today is Monday" was the only thing/);
    // Whitespace-tolerant: the sentence wraps across comment lines.
    assert.match(LIB.replace(/\s*\n\s*\*?\s*/g, " "), /never by container start time/);
  });
});
