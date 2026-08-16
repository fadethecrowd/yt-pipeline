import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canReleaseAttempt, remainingCandidates, MAX_RELEASES_PER_TRANCHE } from "@yt-pipeline/pipeline-core";
import type { ProductionTrancheRow, ProductionTrancheSlotRow } from "@yt-pipeline/pipeline-core";

/**
 * A pre-spend rejection should not cost an authorised attempt.
 *
 * `claimProductionAttempt` runs at src/pipeline.ts:775, before the stage loop at
 * 784, so every gate — including the structural validator inside
 * `scriptGenerator` — is downstream of the claim. Until now a script the
 * pipeline refused for free cost exactly as much as a render that failed after
 * narration was bought.
 *
 * This is not a regression the validator introduced: before 3610e85 the same
 * script consumed the attempt AND spent the credits. What is fixed here is
 * narrower — a failure before any irreversible action is now recoverable, twice
 * per tranche, and only when the durable evidence agrees.
 */

const T0 = new Date("2026-08-16T20:00:00Z");
const tranche = (o: Partial<ProductionTrancheRow> = {}): ProductionTrancheRow => ({
  id: "tr-1", channel: "ai-doom-scroll", maxCandidates: 3,
  consumedCandidates: 1, releasedCandidates: 0, status: "ACTIVE",
  shortsEnabled: false, authorizedBy: "operator", policyCommit: null,
  authorizedAt: T0, expiresAt: new Date(T0.getTime() + 3600_000),
  closedAt: null, closedReason: null, ...o,
});
const slot = (o: Partial<ProductionTrancheSlotRow> = {}): ProductionTrancheSlotRow => ({
  id: "s1", trancheId: "tr-1", channel: "ai-doom-scroll", slotIndex: 0,
  status: "SETTLED_FAILED", videoId: "vid-A", runId: "run-A",
  claimedAt: T0, settledAt: T0, outcome: "run FAILED", ...o,
});
const ask = (o: Record<string, unknown> = {}) => canReleaseAttempt({
  tranche: tranche(), slot: slot(), classificationIsPreSpend: true,
  chargedChars: 0, uploadIntents: 0, hasRenderArtifact: false, ...o,
} as never);

describe("1-8. releasing a pre-spend attempt", () => {
  test("1. deterministic pre-spend rejection with zero charge releases", () => {
    assert.deepEqual(ask(), { ok: true });
  });

  test("2. a post-spend failure does NOT release", () => {
    const r = ask({ chargedChars: 5637, classificationIsPreSpend: false });
    assert.equal(r.ok, false);
    assert.equal((r as { capHit: boolean }).capHit, false);
    // Even if the classification were wrongly marked pre-spend, the charge stops it.
    const r2 = ask({ chargedChars: 5637 });
    assert.equal(r2.ok, false);
    assert.match((r2 as { reason: string }).reason, /5637 narration char\(s\) charged/);
  });

  test("3. an upload intent blocks the release", () => {
    const r = ask({ uploadIntents: 1 });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /upload intent/);
  });

  test("4. a render artifact blocks the release", () => {
    const r = ask({ hasRenderArtifact: true });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /render artifact/);
  });

  test("5. the third release in one tranche is refused and flagged as a cap hit", () => {
    assert.equal(ask({ tranche: tranche({ releasedCandidates: 0 }) }).ok, true);
    assert.equal(ask({ tranche: tranche({ releasedCandidates: 1 }) }).ok, true);
    const r = ask({ tranche: tranche({ releasedCandidates: MAX_RELEASES_PER_TRANCHE }) });
    assert.equal(r.ok, false);
    assert.equal((r as { capHit: boolean }).capHit, true, "a cap hit must be distinguishable");
    assert.match((r as { reason: string }).reason, /stays consumed/);
  });

  test("6. a second call for the same candidate cannot release again", () => {
    const r = ask({ slot: slot({ status: "RELEASED" }) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /already released/);
    // And the durable write is conditional on the slot not already being RELEASED.
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    assert.match(store, /WHERE "videoId"=\$1 AND "status" <> 'RELEASED'/);
    assert.match(store, /if \(marked !== 1\) return \{ released: false/);
  });

  test("7. the audit record carries every required field", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    const fn = store.slice(store.indexOf("export async function releaseProductionAttempt"));
    for (const field of ["videoId", "runId", "classification", "releasedAt",
                         "releaseReason", "releaseClassification", "consumed", "released", "remaining"]) {
      assert.ok(fn.includes(field), `audit must record ${field}`);
    }
    const schema = readFileSync("packages/monitor/prisma/schema.prisma", "utf8");
    for (const col of ["releasedCandidates", "releasedAt", "releaseReason", "releaseClassification"]) {
      assert.match(schema, new RegExp(col), `${col} must be durable`);
    }
  });

  test("8. slot binding is unchanged — the claim still precedes the stage loop", () => {
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    assert.ok(pipeline.indexOf("claimProductionAttempt(video.id") <
      pipeline.indexOf("for (const stage of stages.slice(1))"));
    assert.match(pipeline, /claimSlot\(\{ channel: AI_DOOM_CHANNEL as never, videoId, runId \}\)/);
  });

  test("a released attempt is visibly distinct from one never used", () => {
    const used = tranche({ consumedCandidates: 2, releasedCandidates: 1 });
    assert.equal(remainingCandidates(used), 2, "3 max, 2 consumed, 1 given back");
    const never = tranche({ consumedCandidates: 1, releasedCandidates: 0 });
    assert.equal(remainingCandidates(never), 2);
    // Same remaining, different history — the counts tell them apart.
    assert.notEqual(used.releasedCandidates, never.releasedCandidates);
  });

  test("consumedCandidates stays monotonic so slotIndex stays unique", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    const fn = store.slice(store.indexOf("export async function releaseProductionAttempt"));
    assert.ok(!/consumedCandidates"?\s*=\s*"?consumedCandidates"?\s*-/.test(fn),
      "release must not decrement consumedCandidates");
    assert.match(fn, /"releasedCandidates" = "releasedCandidates" \+ 1/);
  });

  test("only terminal settlement can reach it", () => {
    const ctrl = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.equal((ctrl.match(/deps\.releaseAttempt\(/g) ?? []).length, 1);
    assert.ok(ctrl.indexOf('await settle("FAILED", detail)') < ctrl.indexOf("deps.releaseAttempt("));
    // Nothing in the pipeline itself may release.
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    assert.ok(!pipeline.includes("releaseProductionAttempt"));
  });

  test("only the two zero-spend classifications qualify", () => {
    const ctrl = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.match(ctrl,
      /outcome === "FAILED_BEFORE_SPEND" \|\| outcome === "QUALITY_FAILED"/);
    assert.ok(!ctrl.includes('preSpend = outcome === "FAILED_AFTER_SPEND"'));
  });

  test("a missing tranche or slot releases nothing", () => {
    assert.equal(ask({ tranche: null }).ok, false);
    assert.equal(ask({ slot: null }).ok, false);
  });
});
