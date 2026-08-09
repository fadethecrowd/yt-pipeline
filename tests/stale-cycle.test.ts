import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isClaimStale, channelLockId, CHANNEL_LOCK_IDS,
  CLAIM_STALE_AFTER_MS, PIPELINE_HARD_TIMEOUT_MS,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, CycleStatus, StaleDisposition } from "@yt-pipeline/pipeline-core";

/**
 * Recovering a cycle whose owner is gone.
 *
 * The dangerous mistake here is treating "old" as "abandoned". Age proves
 * nothing about whether a process is alive, so every test below is ultimately
 * about one distinction: a claim that is merely old, versus a claim whose owner
 * the ADVISORY LOCK proves is gone. Only the second may ever be touched, and
 * even then only into a terminal state.
 */

const LIB = readFileSync("packages/pipeline-core/src/lib/staleCycle.ts", "utf8");
const LIMITS = readFileSync("packages/pipeline-core/src/lib/runtimeLimits.ts", "utf8");
const CTRL = readFileSync("scripts/production-cycle-control.ts", "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const LIB_CODE = code(LIB);

const AI = "ai-doom-scroll";
const NOW = new Date("2026-08-09T18:00:00Z");
const OLD = new Date(NOW.getTime() - CLAIM_STALE_AFTER_MS - 60_000);
const RECENT = new Date(NOW.getTime() - 60_000);

function cyc(over: Partial<ProductionCycle> = {}): ProductionCycle {
  return {
    id: "c1", channel: AI, targetPublishSlot: new Date("2026-08-10T19:00:00Z"),
    status: "CLAIMED", claimantId: "unattended:ai-doom-scroll", videoId: null,
    pipelineRunId: null, failureCode: null, authorizedAt: NOW,
    claimedAt: OLD, completedAt: null, failedAt: null, ...over,
  };
}

/**
 * A model of `inspectStaleCycle`'s decision, with the lock and the side-effect
 * queries injected. The real function's SQL is pinned separately below.
 */
function disposition(input: {
  cycle: ProductionCycle | null; lockFree: boolean; youtubeId?: string | null;
  unresolvedIntents?: number; now?: Date;
}): StaleDisposition {
  const { cycle, lockFree } = input;
  const now = input.now ?? NOW;
  if (!cycle) return "NOT_CLAIMED";
  if (cycle.status !== "CLAIMED") return "NOT_CLAIMED";
  if (!isClaimStale(cycle, now)) return "NOT_STALE";
  if (!lockFree) return "OWNER_ALIVE";
  if (!cycle.videoId) return "SAFE_TO_FAIL";
  if (input.youtubeId) return "NEEDS_RECONCILIATION";
  if ((input.unresolvedIntents ?? 0) > 0) return "NEEDS_RECONCILIATION";
  return "SAFE_TO_FAIL";
}

// ── The threshold is derived, not chosen ──────────────────────────────────

describe("stale threshold", () => {
  test("is derived from the hard timeout, not a free-floating literal", () => {
    assert.equal(CLAIM_STALE_AFTER_MS, PIPELINE_HARD_TIMEOUT_MS * 1.5);
    assert.match(code(LIMITS), /CLAIM_STALE_AFTER_MS = PIPELINE_HARD_TIMEOUT_MS \* 1\.5/);
  });

  test("exceeds the ceiling a live process can possibly reach", () => {
    assert.ok(CLAIM_STALE_AFTER_MS > PIPELINE_HARD_TIMEOUT_MS,
      "a process that self-kills at the timeout cannot still hold a claim after it");
  });

  test("is far above the worst observed successful run", () => {
    // Audited 2026-08-09 against pipeline_run LIVE successes: worst 13.3 min.
    const worstObservedMs = 13.3 * 60 * 1000;
    assert.ok(CLAIM_STALE_AFTER_MS / worstObservedMs > 3);
  });

  test("both entrypoints use the shared ceiling rather than their own literal", () => {
    for (const p of ["src/index.ts", "packages/wc-pipeline/src/index.ts"]) {
      const src = code(readFileSync(p, "utf8"));
      assert.match(src, /PIPELINE_TIMEOUT_MS = PIPELINE_HARD_TIMEOUT_MS/);
      assert.doesNotMatch(src, /30 \* 60 \* 1000/);
    }
  });

  test("a recent claim is never stale, an old one always is", () => {
    assert.equal(isClaimStale(cyc({ claimedAt: RECENT }), NOW), false);
    assert.equal(isClaimStale(cyc({ claimedAt: OLD }), NOW), true);
  });
});

// ── Liveness comes from the lock, never from the clock ────────────────────

describe("owner liveness", () => {
  test("a live owner is never reaped, however old the claim", () => {
    assert.equal(disposition({ cycle: cyc(), lockFree: false }), "OWNER_ALIVE");
    const ancient = cyc({ claimedAt: new Date(NOW.getTime() - 30 * 86_400_000) });
    assert.equal(disposition({ cycle: ancient, lockFree: false }), "OWNER_ALIVE");
  });

  test("a free lock alone is not enough — the claim must also be stale", () => {
    assert.equal(disposition({ cycle: cyc({ claimedAt: RECENT }), lockFree: true }), "NOT_STALE");
  });

  test("both conditions together permit terminalisation", () => {
    assert.equal(disposition({ cycle: cyc(), lockFree: true }), "SAFE_TO_FAIL");
  });

  test("the lock is HELD across the update, not checked then released", () => {
    const reap = LIB_CODE.slice(LIB_CODE.indexOf("export async function failAbandonedCycle"));
    const lockAt = reap.indexOf("pg_try_advisory_lock");
    const updateAt = reap.indexOf("UPDATE");
    const unlockAt = reap.indexOf("pg_advisory_unlock");
    assert.ok(lockAt >= 0 && updateAt > lockAt, "lock must precede the update");
    assert.ok(unlockAt > updateAt, "unlock must follow the update — no check-then-act window");
    assert.match(reap, /finally \{\s*await prisma\.\$queryRawUnsafe\(`SELECT pg_advisory_unlock/);
  });

  test("the lock ids match the ones the pipelines actually take", () => {
    assert.equal(channelLockId(AI), 123456);
    assert.equal(channelLockId("wet-circuit"), 789012);
    const wcSrc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.match(wcSrc, /WC_LOCK_ID = 789012/);
    const cfg = readFileSync("packages/pipeline-core/src/config.ts", "utf8");
    assert.match(cfg, /PIPELINE_LOCK_ID: z\.coerce\.number\(\)\.default\(123456\)/);
  });

  test("recovery is channel-isolated — one lock id per channel, no sharing", () => {
    const ids = Object.values(CHANNEL_LOCK_IDS);
    assert.equal(new Set(ids).size, ids.length, "channels must not share a lock");
  });

  test("an unknown channel throws rather than defaulting to some lock", () => {
    assert.throws(() => channelLockId("not-a-channel"));
  });
});

// ── State-sensitive disposition ───────────────────────────────────────────

describe("disposition by state", () => {
  test("no candidate attached → SAFE_TO_FAIL", () => {
    assert.equal(disposition({ cycle: cyc({ videoId: null }), lockFree: true }), "SAFE_TO_FAIL");
  });

  test("candidate with a youtubeId → NEEDS_RECONCILIATION, never FAILED", () => {
    assert.equal(disposition({
      cycle: cyc({ videoId: "v1" }), lockFree: true, youtubeId: "yt-abc",
    }), "NEEDS_RECONCILIATION");
  });

  test("candidate with an unresolved upload intent → NEEDS_RECONCILIATION", () => {
    assert.equal(disposition({
      cycle: cyc({ videoId: "v1" }), lockFree: true, unresolvedIntents: 1,
    }), "NEEDS_RECONCILIATION");
  });

  test("candidate that never reached a remote call → SAFE_TO_FAIL", () => {
    assert.equal(disposition({
      cycle: cyc({ videoId: "v1" }), lockFree: true, youtubeId: null, unresolvedIntents: 0,
    }), "SAFE_TO_FAIL");
  });

  test("narration spend alone does not force reconciliation", () => {
    // Money spent is not an external irreversible effect on the channel. It is
    // recorded in the ledger either way; it does not make the cycle ambiguous.
    assert.equal(disposition({
      cycle: cyc({ videoId: "v1" }), lockFree: true, unresolvedIntents: 0,
    }), "SAFE_TO_FAIL");
  });

  for (const s of ["AUTHORIZED", "COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"] as CycleStatus[]) {
    test(`a ${s} cycle is not a recovery target`, () => {
      assert.equal(disposition({ cycle: cyc({ status: s }), lockFree: true }), "NOT_CLAIMED");
    });
  }
});

// ── The forbidden transitions ─────────────────────────────────────────────

describe("what recovery may never do", () => {
  test("never resets a cycle to AUTHORIZED", () => {
    assert.doesNotMatch(LIB_CODE, /'AUTHORIZED'/);
    assert.doesNotMatch(LIB_CODE, /status"\s*=\s*'AUTHORIZED'/);
  });

  test("never clears claimantId", () => {
    assert.doesNotMatch(LIB_CODE, /claimantId"\s*=\s*NULL/i);
  });

  test("never detaches the candidate", () => {
    assert.doesNotMatch(LIB_CODE, /videoId"\s*=\s*NULL/i);
  });

  test("only ever writes terminal statuses", () => {
    const writes = LIB_CODE.match(/"status" = \$2/g) ?? [];
    assert.equal(writes.length, 1, "exactly one status write");
    assert.match(LIB_CODE, /newStatus = assessment\.disposition === "SAFE_TO_FAIL"\s*\?\s*"FAILED"[\s\S]*?"RECONCILIATION_REQUIRED"/);
  });

  test("the UPDATE restates every precondition", () => {
    const upd = LIB_CODE.slice(LIB_CODE.indexOf('UPDATE "production_cycle"'));
    assert.match(upd, /AND "status" = 'CLAIMED'/);
    assert.match(upd, /AND "claimedAt" IS NOT NULL/);
    assert.match(upd, /AND "claimedAt" < \$4/);
  });

  test("inspection is read-only", () => {
    const inspect = LIB_CODE.slice(
      LIB_CODE.indexOf("export async function inspectStaleCycle"),
      LIB_CODE.indexOf("export interface ReapResult"));
    for (const w of ["UPDATE", "INSERT", "DELETE", "$executeRaw"]) {
      assert.ok(!inspect.includes(w), `inspect must not contain ${w}`);
    }
  });

  test("reaping requires its own acknowledgement, distinct from authorizing", () => {
    assert.match(CTRL, /REAP_ACK = "--i-understand-this-terminates-an-abandoned-cycle"/);
    assert.match(CTRL, /AUTHORIZE_ACK = "--i-understand-this-authorizes-one-unattended-video"/);
    assert.match(LIB_CODE, /if \(!acknowledged\)/);
  });

  test("the dangerous operation is not hidden inside --check", () => {
    const checkFn = CTRL.slice(CTRL.indexOf("export async function doCheck"),
                               CTRL.indexOf("// ── AUTHORIZE"));
    assert.ok(!checkFn.includes("failAbandonedCycle"));
    assert.ok(!checkFn.includes("reap"));
  });
});

// ── Forward progress is bounded without any reaping at all ────────────────

describe("forward progress", () => {
  /** The real predicate from currentRunnableCycle. */
  function blocks(cycle: ProductionCycle, now: Date): boolean {
    return (cycle.status === "AUTHORIZED" || cycle.status === "CLAIMED") &&
      cycle.targetPublishSlot.getTime() > now.getTime();
  }

  test("an abandoned CLAIMED cycle stops blocking once its slot passes", () => {
    const abandoned = cyc({ status: "CLAIMED" });
    const beforeSlot = new Date(abandoned.targetPublishSlot.getTime() - 3600_000);
    const afterSlot = new Date(abandoned.targetPublishSlot.getTime() + 1000);
    assert.equal(blocks(abandoned, beforeSlot), true);
    assert.equal(blocks(abandoned, afterSlot), false,
      "forward progress must resume without any human action");
  });

  test("an expired AUTHORIZED cycle likewise stops blocking", () => {
    const expired = cyc({ status: "AUTHORIZED", claimantId: null, claimedAt: null });
    assert.equal(blocks(expired, new Date(expired.targetPublishSlot.getTime() + 1000)), false);
  });

  test("the blocking window is bounded by the slot, never unbounded", () => {
    const c = cyc();
    const wayLater = new Date(c.targetPublishSlot.getTime() + 365 * 86_400_000);
    assert.equal(blocks(c, wayLater), false);
  });

  test("the predicate under test matches the shipped SQL", () => {
    const src = code(readFileSync("packages/pipeline-core/src/lib/productionCycle.ts", "utf8"));
    const fn = src.slice(src.indexOf("export async function currentRunnableCycle"));
    assert.match(fn, /"status" IN \('AUTHORIZED', 'CLAIMED'\)/);
    assert.match(fn, /"targetPublishSlot" > \$2/);
  });
});
