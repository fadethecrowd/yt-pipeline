import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  approvedAllocationHash, realizedTimelineHash, alignToNarration,
  validateTimingEnvelope, assertRealizedMatchesApproved, AllocationConflictError,
} from "../packages/pipeline-core/src/lib/approvedAllocation";
import type { ApprovedAllocation } from "../packages/pipeline-core/src/lib/approvedAllocation";

/**
 * Rendering a human-approved allocation verbatim.
 *
 * Assembly plans its own beats and searches Pexels at render time. Once a human
 * has inspected specific clips and approved them, doing that again would render
 * footage the reviewer never saw while carrying an approval given to something
 * else. These tests pin the bypass and its fail-closed behaviour.
 */

const alloc = (over: Partial<ApprovedAllocation> = {}): ApprovedAllocation => ({
  scriptSha256: "d5869216599fafdd48a6ef179fa8ce8f90bcea91130800a533926d7815e790ef",
  provenance: { reviewForm: "approved-decisions.v3.csv", reviewSha256: "b16b3729",
                profile: "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY",
                decisions: { APPROVE: 16, ACCEPTABLE_BUT_REPETITIVE: 11 } },
  beats: [
    { beat: 1, durationS: 20, narration: "one",
      fragments: [{ assetId: "a", plannedDurationS: 20, sourceDurationS: 40 }] },
    { beat: 2, durationS: 20, narration: "two",
      fragments: [{ assetId: "b", plannedDurationS: 10, sourceDurationS: 30 },
                  { assetId: "c", plannedDurationS: 10, sourceDurationS: 30 }] },
  ],
  ...over,
});

describe("planning and acquisition are bypassed", () => {
  test("the assembly seam exists on the narrowest interface", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    assert.match(src, /approvedAllocation\?: ApprovedAllocation/);
    assert.match(src, /resolveApprovedAsset\?:/);
  });

  test("the approved path returns before planVisualBeats and gatherCandidates", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    const guard = src.indexOf("if (deps.approvedAllocation)");
    const plan = src.indexOf("const beats = planVisualBeats(");
    const gather = src.indexOf("await gatherCandidates(");
    assert.ok(guard > 0 && plan > 0 && gather > 0);
    assert.ok(guard < plan, "the approved branch must precede beat planning");
    assert.ok(guard < gather, "the approved branch must precede acquisition");
    const branch = src.slice(guard, plan);
    assert.ok(branch.includes("return await finishAssembly"), "the branch must return, not fall through");
    for (const banned of ["planVisualBeats(", "gatherCandidates(", "scoreRelevance(", "buildSearchQueries("]) {
      assert.ok(!branch.includes(banned), `approved path must never call ${banned}`);
    }
  });

  test("the approved renderer performs no selection", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    const fn = src.slice(src.indexOf("async function renderApprovedBeat("),
                         src.indexOf("async function renderBeat("));
    for (const banned of ["scoreRelevance", "selectCandidate", "gatherCandidates", "pool"]) {
      assert.ok(!fn.includes(banned), `renderApprovedBeat must not use ${banned}`);
    }
    assert.ok(fn.includes("resolveApprovedAsset"), "it must resolve approved ids directly");
  });
});

describe("alignment adjusts durations, never the assets", () => {
  test("fragments scale proportionally to the aligned beat", () => {
    const out = alignToNarration(alloc(), new Map([[1, 22], [2, 18]]));
    assert.equal(out[0]!.fragments[0]!.plannedDurationS, 22);
    assert.equal(out[1]!.fragments[0]!.plannedDurationS, 9);
    assert.equal(out[1]!.fragments[1]!.plannedDurationS, 9);
  });

  test("asset identity and order are untouched", () => {
    const out = alignToNarration(alloc(), new Map([[1, 25], [2, 15]]));
    assert.deepEqual(out.flatMap((b) => b.fragments.map((f) => f.assetId)), ["a", "b", "c"]);
  });

  test("a card keeps its approved duration exactly", () => {
    const a = alloc({ beats: [{ beat: 1, durationS: 20, narration: "x", hasCard: true,
      cardSecondsS: 4, cardText: "card",
      fragments: [{ assetId: "a", plannedDurationS: 16, sourceDurationS: 40 }] }] });
    const out = alignToNarration(a, new Map([[1, 24]]));
    assert.equal(out[0]!.cardSecondsS, 4, "cards are approved as readable at their length");
    assert.equal(out[0]!.fragments[0]!.plannedDurationS, 20);
  });

  test("a continuation stays one take carrying its exact seconds", () => {
    const a = alloc({ beats: [
      { beat: 1, durationS: 20, narration: "x", fragments: [
        { assetId: "a", plannedDurationS: 23, sourceDurationS: 40, continuesIntoBeat: 2, continuationSeconds: 3 }] },
      { beat: 2, durationS: 20, narration: "y",
        continuedFrom: { assetId: "a", fromBeat: 1, seconds: 3 },
        fragments: [{ assetId: "b", plannedDurationS: 17, sourceDurationS: 30 }] },
    ] });
    const out = alignToNarration(a, new Map([[1, 20], [2, 20]]));
    assert.equal(out[0]!.fragments[0]!.continuationSeconds, 3);
    assert.equal(out[0]!.fragments[0]!.plannedDurationS, 23, "own share + carried seconds");
    assert.equal(out[1]!.continuedFrom!.seconds, 3);
  });
});

describe("fail closed", () => {
  test("a fragment exceeding its source fails", () => {
    const a = alloc({ beats: [{ beat: 1, durationS: 20, narration: "x",
      fragments: [{ assetId: "a", plannedDurationS: 20, sourceDurationS: 21 }] }] });
    assert.throws(() => alignToNarration(a, new Map([[1, 40]])), AllocationConflictError);
  });

  test("a fragment shrinking below the floor fails", () => {
    const a = alloc({ beats: [{ beat: 1, durationS: 20, narration: "x", fragments: [
      { assetId: "a", plannedDurationS: 18, sourceDurationS: 40 },
      { assetId: "b", plannedDurationS: 2, sourceDurationS: 40 }] }] });
    assert.throws(() => alignToNarration(a, new Map([[1, 10]])), AllocationConflictError);
  });

  test("a card longer than the aligned beat fails", () => {
    const a = alloc({ beats: [{ beat: 1, durationS: 20, narration: "x", hasCard: true,
      cardSecondsS: 4, fragments: [{ assetId: "a", plannedDurationS: 16, sourceDurationS: 40 }] }] });
    assert.throws(() => alignToNarration(a, new Map([[1, 3]])), AllocationConflictError);
  });

  test("an altered asset id fails", () => {
    assert.throws(() => assertRealizedMatchesApproved(alloc(), ["a", "X", "c"]),
      /order diverged|disappeared|appeared/);
  });

  test("an altered order fails", () => {
    assert.throws(() => assertRealizedMatchesApproved(alloc(), ["a", "c", "b"]), /order diverged/);
  });

  test("a missing asset fails", () => {
    assert.throws(() => assertRealizedMatchesApproved(alloc(), ["a", "b"]), /render used 2 assets/);
  });

  test("an extra asset fails", () => {
    assert.throws(() => assertRealizedMatchesApproved(alloc(), ["a", "b", "c", "d"]), /render used 4/);
  });

  test("the exact approved set in order passes", () => {
    assert.doesNotThrow(() => assertRealizedMatchesApproved(alloc(), ["a", "b", "c"]));
  });
});

describe("hashes bind the render to the approval", () => {
  test("the allocation hash is stable and covers identity", () => {
    assert.equal(approvedAllocationHash(alloc()), approvedAllocationHash(alloc()));
  });

  test("changing an asset changes the hash", () => {
    const b = alloc();
    b.beats[1]!.fragments[0]!.assetId = "zzz";
    assert.notEqual(approvedAllocationHash(alloc()), approvedAllocationHash(b));
  });

  test("changing the script changes the hash", () => {
    assert.notEqual(approvedAllocationHash(alloc()),
      approvedAllocationHash(alloc({ scriptSha256: "different" })));
  });

  test("the realized hash covers the audio and the final cuts", () => {
    const t = { approvedAllocationHash: "h", audioSha256: "aud", totalDurationS: 40,
      beats: [{ beat: 1, startS: 0, durationS: 20, continuedFromSeconds: 0, cardSecondsS: 0,
        fragments: [{ assetId: "a", beat: 1, sourceInS: 0, sourceOutS: 20, durationS: 20 }] }] };
    assert.notEqual(realizedTimelineHash(t), realizedTimelineHash({ ...t, audioSha256: "other" }));
  });
});

describe("timing envelope", () => {
  test("a healthy allocation survives ±10%", () => {
    const r = validateTimingEnvelope(alloc());
    assert.equal(r.ok, true, r.failures.join("; "));
  });

  test("an allocation with no headroom fails the envelope before any spend", () => {
    const a = alloc({ beats: [{ beat: 1, durationS: 20, narration: "x",
      fragments: [{ assetId: "a", plannedDurationS: 20, sourceDurationS: 20.5 }] }] });
    assert.equal(validateTimingEnvelope(a).ok, false);
  });
});

describe("absent allocation preserves existing behaviour", () => {
  test("the normal path still plans and acquires", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    const after = src.slice(src.indexOf("const beats = planVisualBeats("));
    assert.ok(after.includes("gatherCandidates("), "normal path must still acquire");
    assert.ok(after.includes("renderBeat("), "normal path must still select per beat");
    assert.ok(src.includes("return await finishAssembly"), "both paths share the mux");
  });
});
