import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solveApprovedStrip, MAX_CLIP_S } from "../packages/pipeline-core/src/lib/approvedStrip";
import type { StripAsset, StripBeat } from "../packages/pipeline-core/src/lib/approvedStrip";
import { MIN_FRAGMENT_S, AllocationConflictError } from "../packages/pipeline-core/src/lib/approvedAllocation";

/**
 * The continuation encoding, pinned.
 *
 * Assembly cuts every fragment from the START of its source. A clip listed
 * once per beat it touches therefore replays its own opening in each of them —
 * a loop wearing a continuation's clothes, and precisely what the approval
 * forbids. The v5 allocation was built that way and would have rendered three
 * repeats of one clip across beats 6, 7 and 8.
 *
 * A clip must therefore appear exactly ONCE, in the beat where it starts,
 * carrying the whole screen time it occupies.
 */

const assets = (spec: [string, number][]): StripAsset[] =>
  spec.map(([assetId, sourceDurationS]) => ({ assetId, sourceDurationS }));
const beats = (durs: number[], cards: Record<number, number> = {}): StripBeat[] =>
  durs.map((durationS, i) => ({
    beat: i + 1, durationS, narration: `beat ${i + 1}`,
    ...(cards[i + 1] ? { hasCard: true, cardSecondsS: cards[i + 1], cardText: `card ${i + 1}` } : {}),
  }));

describe("each approved clip appears exactly once", () => {
  const A = assets([["a", 40], ["b", 40], ["c", 40]]);
  const B = beats([20, 20, 20]);

  test("one fragment per asset, no matter how many beats it spans", () => {
    const out = solveApprovedStrip(A, B);
    const used = out.flatMap((b) => b.fragments.map((f) => f.assetId));
    assert.deepEqual(used, ["a", "b", "c"], "each clip exactly once, in approved order");
    assert.equal(new Set(used).size, 3);
  });

  test("a clip that crosses a boundary records the carry, not a second fragment", () => {
    // Uneven beats, so a clip boundary cannot coincide with a beat boundary.
    const out = solveApprovedStrip(assets([["a", 40], ["b", 40]]), beats([25, 15]));
    const spanning = out.flatMap((b) => b.fragments).find((f) => f.continuesIntoBeat);
    assert.ok(spanning, "this fixture must produce a spanning clip");
    const appearances = out.flatMap((b) => b.fragments).filter((f) => f.assetId === spanning!.assetId);
    assert.equal(appearances.length, 1, "a spanning clip must not be listed twice");
    assert.ok(out.some((b) => b.continuedFrom?.assetId === spanning!.assetId));
  });

  test("a clip spanning three beats is still one fragment", () => {
    // One long clip and two short ones across four short beats.
    const out = solveApprovedStrip(assets([["long", 30], ["x", 8], ["y", 8]]), beats([9, 9, 9, 9]));
    const all = out.flatMap((b) => b.fragments);
    assert.equal(all.filter((f) => f.assetId === "long").length, 1);
    const carriers = out.filter((b) => b.continuedFrom?.assetId === "long");
    assert.ok(carriers.length >= 1);
  });
});

describe("beats are covered exactly", () => {
  for (const [label, A, B] of [
    ["even", assets([["a", 40], ["b", 40], ["c", 40]]), beats([20, 20, 20])],
    ["uneven", assets([["a", 60], ["b", 12], ["c", 30], ["d", 9]]), beats([25, 14, 19, 22])],
    ["with cards", assets([["a", 40], ["b", 40], ["c", 40]]), beats([20, 20, 20], { 2: 4 })],
  ] as [string, StripAsset[], StripBeat[]][]) {
    test(label, () => {
      const out = solveApprovedStrip(A, B);
      for (const b of out) {
        const own = b.fragments.reduce((a, f) => a + f.plannedDurationS - (f.continuationSeconds ?? 0), 0);
        const covered = own + (b.continuedFrom?.seconds ?? 0) + (b.cardSecondsS ?? 0);
        assert.ok(Math.abs(covered - b.durationS) < 0.05,
          `beat ${b.beat} covered ${covered.toFixed(3)} of ${b.durationS}`);
      }
    });
  }

  test("total screen time equals total beat time", () => {
    const B = beats([25, 14, 19, 22]);
    const out = solveApprovedStrip(assets([["a", 60], ["b", 12], ["c", 30], ["d", 9]]), B);
    const screen = out.flatMap((b) => b.fragments).reduce((a, f) => a + f.plannedDurationS, 0);
    const target = B.reduce((a, b) => a + b.durationS, 0);
    assert.ok(Math.abs(screen - target) < 0.05, `${screen} vs ${target}`);
  });
});

describe("legal source use only", () => {
  const out = solveApprovedStrip(assets([["a", 60], ["b", 12], ["c", 30], ["d", 9]]), beats([25, 14, 19, 22]));

  test("no clip overruns its source", () => {
    for (const f of out.flatMap((b) => b.fragments)) {
      assert.ok(f.plannedDurationS * (f.playbackRate ?? 1) <= f.sourceDurationS + 1e-3,
        `${f.assetId} needs ${(f.plannedDurationS * (f.playbackRate ?? 1)).toFixed(3)}s of ${f.sourceDurationS}s`);
    }
  });

  test("every clip clears the fragment floor", () => {
    for (const f of out.flatMap((b) => b.fragments)) {
      assert.ok(f.plannedDurationS >= MIN_FRAGMENT_S - 1e-6, `${f.assetId} ${f.plannedDurationS}s`);
    }
  });

  test("no clip exceeds the single-clip cap", () => {
    for (const f of out.flatMap((b) => b.fragments)) {
      assert.ok(f.plannedDurationS <= MAX_CLIP_S + 1e-6, `${f.assetId} ${f.plannedDurationS}s`);
    }
  });

  test("playback rates stay inside the authorised range and prefer 1.0", () => {
    for (const f of out.flatMap((b) => b.fragments)) {
      const r = f.playbackRate ?? 1;
      assert.ok(r >= 0.92 - 1e-9 && r <= 1.08 + 1e-9, `${f.assetId} rate ${r}`);
    }
  });

  test("a clip with ample source plays at exactly 1.0", () => {
    const o = solveApprovedStrip(assets([["a", 40], ["b", 40]]), beats([15, 15]));
    for (const f of o.flatMap((b) => b.fragments)) assert.equal(f.playbackRate, 1);
  });
});

describe("cards are never covered by a clip running through them", () => {
  test("a clip stops at the boundary of a card beat", () => {
    const out = solveApprovedStrip(assets([["a", 40], ["b", 40], ["c", 40]]), beats([20, 20, 20], { 2: 4, 3: 4 }));
    for (const b of out) {
      if (b.hasCard) assert.equal(b.continuedFrom, undefined, `beat ${b.beat} has a clip running over its card`);
    }
  });

  test("card identity and text are carried through untouched", () => {
    const out = solveApprovedStrip(assets([["a", 40], ["b", 40], ["c", 40]]), beats([20, 20, 20], { 2: 4 }));
    const card = out.find((b) => b.hasCard)!;
    assert.equal(card.cardText, "card 2");
    assert.equal(card.cardSecondsS, 4);
  });
});

describe("fails closed", () => {
  test("not enough source to cover the runtime", () => {
    assert.throws(() => solveApprovedStrip(assets([["a", 5], ["b", 5]]), beats([30, 30])),
      (e: Error) => e instanceof AllocationConflictError && /at most/.test(e.message));
  });

  test("too many clips to clear the floor", () => {
    const many = assets(Array.from({ length: 20 }, (_, i) => [`a${i}`, 30] as [string, number]));
    assert.throws(() => solveApprovedStrip(many, beats([20, 20])),
      (e: Error) => /cannot each clear/.test(e.message));
  });

  test("a card longer than its beat", () => {
    assert.throws(() => solveApprovedStrip(assets([["a", 40]]), beats([5], { 1: 4 })),
      (e: Error) => /left for footage/.test(e.message));
  });

  test("no assets and no beats", () => {
    assert.throws(() => solveApprovedStrip([], beats([10])), AllocationConflictError);
    assert.throws(() => solveApprovedStrip(assets([["a", 10]]), []), AllocationConflictError);
  });
});

describe("deterministic and order-preserving", () => {
  const A = assets([["a", 60], ["b", 12], ["c", 30], ["d", 9]]);
  const B = beats([25, 14, 19, 22]);
  test("same input, same output", () => {
    assert.deepEqual(solveApprovedStrip(A, B), solveApprovedStrip(A, B));
  });
  test("approved order is preserved in the rendered sequence", () => {
    const used = solveApprovedStrip(A, B).flatMap((b) => b.fragments.map((f) => f.assetId));
    assert.deepEqual(used, A.map((a) => a.assetId));
  });
});

describe("the real approved v5 set", () => {
  const path = "tmp/qual-dc-v5/approved-allocation.v5.json";
  let v5: any = null;
  try { v5 = JSON.parse(readFileSync(path, "utf8")); } catch { /* artifact not present */ }

  test("solves across the whole ±10% envelope", { skip: !v5 }, () => {
    const seen = new Set<string>();
    const A: StripAsset[] = [];
    for (const b of v5.beats) for (const f of b.fragments) {
      if (!seen.has(f.assetId)) { seen.add(f.assetId); A.push({ assetId: f.assetId, sourceDurationS: f.sourceDurationS }); }
    }
    assert.equal(A.length, 25);
    for (const v of [0.9, 1.0, 1.1]) {
      const B: StripBeat[] = v5.beats.map((b: any) => ({
        beat: b.beat, durationS: +(b.durationS * v).toFixed(3), narration: b.narration,
        ...(b.hasCard ? { hasCard: true, cardSecondsS: b.cardSecondsS, cardText: b.cardText } : {}),
      }));
      const out = solveApprovedStrip(A, B);
      const used = out.flatMap((x) => x.fragments.map((f) => f.assetId));
      assert.deepEqual(used, A.map((a) => a.assetId), `variation ${v}: asset set or order changed`);
      for (const f of out.flatMap((x) => x.fragments)) {
        const r = f.playbackRate ?? 1;
        assert.ok(r >= 0.92 - 1e-9 && r <= 1.08 + 1e-9, `variation ${v}: ${f.assetId} rate ${r}`);
        assert.ok(f.plannedDurationS * r <= f.sourceDurationS + 1e-3, `variation ${v}: ${f.assetId} overrun`);
      }
    }
  });
});
