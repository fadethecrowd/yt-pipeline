import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/**
 * Timeline coverage must be derived, never asserted.
 *
 * The v3 manifest reported uncoveredBeats: [] while four beats carried
 * uncoveredS of 3.0, 2.1, 1.9 and 2.7 — 9.7 seconds of narration with nothing
 * on screen. The cause was a threshold in the summary step: uncoveredBeats was
 * filtered with `uncoveredS > 3`, so every gap under three seconds vanished
 * from the summary and from the report built on it.
 *
 * A gap of 2.7s is not a rounding artefact, it is three seconds of black. Any
 * beat with a gap at all is uncovered.
 *
 * A clip that runs across a beat boundary is ONE continuous use of one source.
 * It must not be counted as a second instance of that asset, which would make
 * a legitimate continuous take look like duplicate reuse.
 */

export interface Beat {
  beat: number; durationS: number;
  fragments: { assetId: string; plannedDurationS: number;
               continuesIntoBeat?: number; continuationSeconds?: number }[];
  continuedFrom?: { assetId: string; fromBeat: number; seconds: number };
  hasCard?: boolean; cardSecondsS?: number; cardText?: string | null;
}

/** Seconds actually on screen for a beat. */
export function coveredSeconds(b: Beat): number {
  const frag = b.fragments.reduce(
    (a, f) => a + (f.plannedDurationS - (f.continuationSeconds ?? 0)), 0);
  const cont = b.continuedFrom ? b.continuedFrom.seconds : 0;
  return +(frag + cont + (b.hasCard ? (b.cardSecondsS ?? 0) : 0)).toFixed(2);
}

export function uncoveredSeconds(b: Beat): number {
  return +Math.max(0, +(b.durationS - coveredSeconds(b)).toFixed(2)).toFixed(2);
}

/** Distinct sources. A cross-beat continuation is one source, not two. */
export function distinctSources(beats: Beat[]): string[] {
  return [...new Set(beats.flatMap((b) => b.fragments.map((f) => f.assetId)))];
}

describe("coverage is derived from the beats", () => {
  test("a sub-threshold gap is still a gap", () => {
    const b: Beat = { beat: 1, durationS: 17.3,
      fragments: [{ assetId: "a", plannedDurationS: 14.3 }] };
    assert.equal(uncoveredSeconds(b), 3);
    assert.ok(uncoveredSeconds(b) > 0, "2-3s of black must never read as covered");
  });

  test("uncoveredBeats cannot be empty while a beat is uncovered", () => {
    const beats: Beat[] = [
      { beat: 1, durationS: 10, fragments: [{ assetId: "a", plannedDurationS: 10 }] },
      { beat: 2, durationS: 10, fragments: [{ assetId: "b", plannedDurationS: 7.3 }] },
    ];
    const derived = beats.filter((x) => uncoveredSeconds(x) > 0).map((x) => x.beat);
    assert.deepEqual(derived, [2]);
    // The exact v3 defect: a summary claiming none while a beat has a gap.
    const claimed: number[] = [];
    assert.notDeepEqual(claimed, derived,
      "a summary claiming full coverage must not survive a beat-level gap");
  });

  test("a threshold may never be applied when deriving uncovered beats", () => {
    const beats: Beat[] = [1.9, 2.1, 2.7, 3.0].map((gap, i) => ({
      beat: i + 1, durationS: 17.3,
      fragments: [{ assetId: `a${i}`, plannedDurationS: 17.3 - gap }],
    }));
    const derived = beats.filter((x) => uncoveredSeconds(x) > 0).map((x) => x.beat);
    assert.deepEqual(derived, [1, 2, 3, 4],
      "every gap counts — this is the exact set v3 reported as none");
    assert.equal(+beats.reduce((a, x) => a + uncoveredSeconds(x), 0).toFixed(1), 9.7);
  });
});

describe("cross-beat continuation is one source use", () => {
  const beats: Beat[] = [
    { beat: 3, durationS: 17.3, fragments: [
      { assetId: "1085656", plannedDurationS: 20.3, continuesIntoBeat: 4, continuationSeconds: 3 }] },
    { beat: 4, durationS: 17.3,
      fragments: [{ assetId: "7140937", plannedDurationS: 14.3 }],
      continuedFrom: { assetId: "1085656", fromBeat: 3, seconds: 3 } },
  ];

  test("both beats are fully covered by the continuation", () => {
    assert.equal(uncoveredSeconds(beats[0]!), 0);
    assert.equal(uncoveredSeconds(beats[1]!), 0);
  });

  test("the continued clip is counted once, not as duplicate reuse", () => {
    const sources = distinctSources(beats);
    assert.equal(sources.length, 2, "one continuous take must not read as two assets");
    assert.equal(sources.filter((s) => s === "1085656").length, 1);
    const total = beats.flatMap((b) => b.fragments).length;
    assert.equal(total, sources.length, "noSourceReuse must survive a continuation");
  });

  test("a genuine duplicate is still caught", () => {
    const dup: Beat[] = [
      { beat: 1, durationS: 10, fragments: [{ assetId: "x", plannedDurationS: 10 }] },
      { beat: 2, durationS: 10, fragments: [{ assetId: "x", plannedDurationS: 10 }] },
    ];
    const frags = dup.flatMap((b) => b.fragments).length;
    assert.notEqual(frags, distinctSources(dup).length,
      "the same asset used twice without a continuation is reuse");
  });
});

const PKG = "tmp/qual-dc-v4/review/qualification-review.json";
describe("the shipped package is fully covered", { skip: !existsSync(PKG) }, () => {
  const p = existsSync(PKG) ? JSON.parse(readFileSync(PKG, "utf8")) : null;

  test("every beat has zero uncovered seconds", () => {
    for (const b of p.beats) {
      assert.equal(uncoveredSeconds(b), 0, `beat ${b.beat} leaves ${uncoveredSeconds(b)}s uncovered`);
    }
  });

  test("uncoveredBeats matches what the beats say", () => {
    assert.deepEqual(p.uncoveredBeats, p.beats.filter((b: Beat) => uncoveredSeconds(b) > 0).map((b: Beat) => b.beat));
    assert.equal(p.totalUncoveredS, 0);
  });

  test("sources are unique and reuse stays false", () => {
    const frags = p.beats.flatMap((b: Beat) => b.fragments);
    assert.equal(distinctSources(p.beats).length, frags.length);
    assert.equal(p.integrity.noSourceReuse, true);
    assert.equal(p.integrity.noFrozenExtension, true);
    assert.equal(p.integrity.noLoops, true);
    assert.equal(p.integrity.noReverse, true);
    assert.equal(p.integrity.noPingPong, true);
  });

  test("cards stay within their limits", () => {
    const cards = p.beats.filter((b: Beat) => b.hasCard);
    assert.ok(cards.length <= 4, `${cards.length} cards`);
    for (const c of cards) assert.ok((c.cardSecondsS ?? 0) <= 5, `card on beat ${c.beat} too long`);
    assert.equal(new Set(cards.map((c: Beat) => c.cardText)).size, cards.length, "card texts must be unique");
    for (let i = 1; i < p.beats.length; i++) {
      assert.ok(!(p.beats[i].hasCard && p.beats[i - 1].hasCard), "cards must not be consecutive");
    }
  });
});
