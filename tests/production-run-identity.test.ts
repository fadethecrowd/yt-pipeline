import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RunSummary, canClaimSlot, checkSlotAuthority } from "@yt-pipeline/pipeline-core";
import type { ProductionTrancheRow, ProductionTrancheSlotRow } from "@yt-pipeline/pipeline-core";

/**
 * The first real ordinary-production attempt, 2026-08-14.
 *
 * A human authorized an N=1 tranche and launched the controller in the
 * foreground. Topic discovery ran, a fresh candidate `cmstlq7jw0004mbtr70ljzg5s`
 * was created, and the pipeline refused two seconds later:
 *
 *   refused at claimProductionAttempt: no run identity available
 *   — a production candidate must be bound to its run before it may spend
 *
 * and the controller then reported:
 *
 *   OUTCOME : OBSERVATION_FAILED
 *   reason  : no pipeline run appeared after the watermark
 *
 * Both symptoms are one cause, and it is not the tranche. `RunSummary` mints
 * `runId` at construction and has since bb337b6 — but the ordinary-production
 * controller called `runPipeline()` with no summary at all. `src/index.ts`, the
 * container entry point, has always constructed one; the controller bypasses
 * that entry point deliberately (so Railway stays locked) and inherited none of
 * its lifecycle.
 *
 * So `summary?.runId` was undefined, the claim correctly refused a candidate
 * with no run identity, and nothing ever called `persist()` — hence no run row
 * for the controller to find. The guard worked exactly as designed. What was
 * missing was the prerequisite it guards.
 *
 * Zero characters were charged, nothing was rendered, nothing was uploaded, and
 * the tranche slot was never claimed.
 */

const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");
const PIPELINE = readFileSync("src/pipeline.ts", "utf8");
const ENTRY = readFileSync("src/index.ts", "utf8");

const T0 = new Date("2026-08-14T23:52:00.000Z");
const CH = "ai-doom-scroll" as const;

function tranche(over: Partial<ProductionTrancheRow> = {}): ProductionTrancheRow {
  return {
    id: "tr-live", channel: CH, maxCandidates: 1, consumedCandidates: 0,
    status: "ACTIVE", shortsEnabled: false, authorizedBy: "operator",
    policyCommit: "f0ab496", authorizedAt: T0,
    expiresAt: new Date(T0.getTime() + 6 * 3600_000),
    closedAt: null, closedReason: null, ...over,
  };
}

// ── 1-13. Run identity ───────────────────────────────────────────────────

describe("1-13. one execution, one immutable run identity", () => {
  test("1. a RunSummary has an id from the moment it exists", () => {
    const s = new RunSummary("ai-doom-scroll", "LIVE");
    assert.ok(s.runId, "no identity at construction");
    assert.match(s.runId, /^[0-9a-f-]{36}$/);
  });

  test("2. the id is immutable and readonly", () => {
    const s = new RunSummary("ai-doom-scroll", "LIVE");
    const first = s.runId;
    s.setVideoId("vid-A");
    s.addWarning("something");
    s.markFailed("stage", new Error("x"));
    assert.equal(s.runId, first, "the identity must not move during a run");
    const src = readFileSync("packages/pipeline-core/src/lib/pipelineRun.ts", "utf8");
    assert.match(src, /readonly runId: string = randomUUID\(\)/);
  });

  test("collision-safe: distinct summaries never share an id", () => {
    const ids = new Set(Array.from({ length: 200 }, () => new RunSummary("ai-doom-scroll", "LIVE").runId));
    assert.equal(ids.size, 200);
  });

  test("9/10. the persisted row carries exactly that id, and only one row", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/pipelineRun.ts", "utf8");
    assert.match(src, /id: this\.runId/, "persist must not let the DB mint a second identity");
    // `persisted` guards re-entry, so a double persist writes one row.
    assert.match(src, /if \(this\.persisted\) return;/);
    assert.equal((src.match(/prisma\.pipelineRun\.create/g) ?? []).length, 1);
  });

  test("3/11. the controller now gives every invocation an identity", () => {
    const body = CTRL.slice(CTRL.indexOf("async invokePipeline("), CTRL.indexOf("async runById("));
    assert.match(body, /new RunSummary\(channel, runMode\)/);
    assert.match(body, /runPipeline\(summary\)/);
    // Named in prose in the comment above it; what must not exist is the CALL.
    assert.ok(!/await runPipeline\(\)/.test(body),
      "this is the bug: runPipeline() with no summary produced no run identity");
    assert.match(body, /return \{ runId: summary\.runId \}/);
  });

  test("12/13. it terminalizes in a finally, so early failures still persist", () => {
    const body = CTRL.slice(CTRL.indexOf("async invokePipeline("), CTRL.indexOf("async runById("));
    assert.match(body, /finally \{\s*\n\s*await summary\.persist\(\);/);
    assert.match(body, /catch \(err\)[\s\S]*markFailed\("__controller__"/,
      "a thrown pipeline must still record why");
  });

  test("the controller mirrors the container entry point's lifecycle", () => {
    // src/index.ts always did this correctly; the controller simply bypassed it.
    assert.match(ENTRY, /new RunSummary\("ai-doom-scroll", runMode\)/);
    assert.match(ENTRY, /runPipeline\(summary\)/);
    assert.match(ENTRY, /await summary\.persist\(\)/);
  });

  test("6/7/8. downstream authority is scoped to ctx.runId, one value", () => {
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.match(vo, /runId: ctx\.runId/);           // narration
    const boundary = PIPELINE.slice(PIPELINE.indexOf("async function assertSupervisedBoundary"),
      PIPELINE.indexOf("/**\n * Stamp the concrete execution identity"));
    assert.match(boundary, /runId: ctx\.runId/);      // render + upload
    // ctx.runId is only ever the summary's id — never re-derived.
    assert.equal((PIPELINE.match(/runId: summary\?\.runId/g) ?? []).length, 2,
      "fresh and resumed paths, both from the same summary");
  });

  test("4. a resumed candidate gets the CURRENT run's identity", () => {
    assert.match(PIPELINE, /claimProductionAttempt\(stuckVideo\.id, summary\?\.runId\)/);
    assert.match(PIPELINE, /bindSupervisedIdentity\(stuckVideo\.id, summary\?\.runId\)/);
    // Never a stored/previous run id.
    assert.ok(!/stuckVideo\.runId|previousRunId/.test(PIPELINE));
  });

  test("3. a fresh candidate gets the current run's identity", () => {
    assert.match(PIPELINE, /claimProductionAttempt\(video\.id, summary\?\.runId\)/);
  });
});

// ── The exact incident, reproduced ───────────────────────────────────────

describe("the 2026-08-14 incident: claim now succeeds, guard unchanged", () => {
  test("with a run identity, an N=1 tranche claim succeeds", () => {
    const r = canClaimSlot(tranche(), {
      channel: CH, videoId: "cmstlq7jw0004mbtr70ljzg5s",
      runId: new RunSummary("ai-doom-scroll", "LIVE").runId, now: T0,
    });
    assert.deepEqual(r, { ok: true, slotIndex: 0 });
  });

  test("without one, the claim still refuses — the guard was never the bug", () => {
    const r = canClaimSlot(tranche(), {
      channel: CH, videoId: "cmstlq7jw0004mbtr70ljzg5s", runId: "", now: T0,
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /needs both a candidate and a run/);
  });

  test("the pipeline refuses a production candidate with no run identity", () => {
    const body = PIPELINE.slice(PIPELINE.indexOf("async function claimProductionAttempt"),
      PIPELINE.indexOf("/** Render is the first materially"));
    assert.match(body, /if \(!runId\)/);
    assert.match(body, /no run identity available/);
    assert.match(body, /success: false/);
    // Not weakened to candidate-only, channel-only or tranche-only.
    assert.match(body, /claimSlot\(\{ channel: AI_DOOM_CHANNEL as never, videoId, runId \}\)/);
  });

  test("a null run id is never a wildcard", () => {
    const bound = { ...tranche(), consumedCandidates: 1, status: "EXHAUSTED" as const };
    const slot: ProductionTrancheSlotRow = {
      id: "s1", trancheId: "tr-live", channel: CH, slotIndex: 0, status: "CLAIMED",
      videoId: "vid-A", runId: "run-A", claimedAt: T0, settledAt: null, outcome: null,
    };
    for (const runId of ["", "run-B", "undefined", "null"]) {
      assert.equal(checkSlotAuthority(slot, bound,
        { channel: CH, videoId: "vid-A", runId, now: T0 }).authorized, false, runId);
    }
    assert.equal(checkSlotAuthority(slot, bound,
      { channel: CH, videoId: "vid-A", runId: "run-A", now: T0 }).authorized, true);
  });
});

// ── 23-30. Observation ───────────────────────────────────────────────────

describe("23-30. the controller observes the run it actually started", () => {
  test("23/25. correlation is by exact id, not by timestamp guessing", () => {
    const body = CTRL.slice(CTRL.indexOf('steps.push("identify-run")'),
      CTRL.indexOf('steps.push("classify")'));
    assert.match(body, /startedRunId \? await deps\.runById\(startedRunId\) : null/);
    assert.match(body, /run\?\.videoId \? await deps\.rowById/,
      "the run names its own candidate");
  });

  test("26/27. the watermark scan survives only as a fallback", () => {
    const body = CTRL.slice(CTRL.indexOf('steps.push("identify-run")'),
      CTRL.indexOf('steps.push("classify")'));
    // Exact lookup is attempted first; the scan runs only when it returns null.
    assert.ok(body.indexOf("runById") < body.indexOf("runsSince"),
      "exact identity must take precedence over 'newest row after a timestamp'");
    assert.match(body, /if \(!run\) \{/);
  });

  test("24. an early failure is no longer invisible", () => {
    // Persist happens in a finally, so a run that dies before any stage still
    // leaves a terminal row carrying the id the controller already holds.
    const body = CTRL.slice(CTRL.indexOf("async invokePipeline("), CTRL.indexOf("async runById("));
    assert.match(body, /finally/);
    assert.match(body, /persist\(\)/);
  });

  test("28/29/30. the outcome-reporting fixes are untouched", () => {
    assert.match(CTRL, /const COMPLETED = \["SUCCESS", "WARNING"\]/);
    assert.match(CTRL, /if \(video\?\.youtubeId\) \{/);
    assert.match(CTRL, /Never infer "no spend" from status/);
  });
});

// ── 14-22. Tranche accounting is unchanged ───────────────────────────────

describe("14-22. the tranche rules did not move", () => {
  test("14/15. one claim consumes the attempt; failure keeps it consumed", () => {
    assert.deepEqual(canClaimSlot(tranche(), {
      channel: CH, videoId: "vid-A", runId: "run-A", now: T0 }), { ok: true, slotIndex: 0 });
    const after = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(canClaimSlot(after,
      { channel: CH, videoId: "vid-B", runId: "run-B", now: T0 }).ok, false);
  });

  test("16/17. a controller retry cannot reclaim capacity", () => {
    const after = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    for (const id of ["run-B", "run-C"]) {
      assert.equal(canClaimSlot(after, { channel: CH, videoId: "vid-B", runId: id, now: T0 }).ok, false);
    }
  });

  test("the claim still runs under a row lock with a unique backstop", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    assert.match(store, /FOR UPDATE/);
    assert.match(store, /\$transaction/);
    const schema = readFileSync("packages/monitor/prisma/schema.prisma", "utf8");
    assert.match(schema, /@@unique\(\[trancheId, slotIndex\]\)/);
  });

  test("33/34/35. standing budget, breaker and ceiling are untouched", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    for (const f of ["setBudgetLimit", "limitChars", "DISABLE_ELEVEN", "circuitBreaker"]) {
      assert.ok(!store.includes(f), `the tranche must not touch ${f}`);
    }
  });

  test("36. Shorts stay off unless a tranche says otherwise", () => {
    const pilot = readFileSync("packages/pipeline-core/src/lib/pilot.ts", "utf8");
    assert.match(pilot, /shortsEnabled: productionPolicy\?\.shortsEnabled \?\? false/);
  });
});
