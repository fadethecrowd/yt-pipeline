import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  beatSpansForUnit, beatSpansForNarration, AlignmentError,
} from "../packages/pipeline-core/src/lib/narrationAlignment";
import type { BeatRange } from "../packages/pipeline-core/src/lib/narrationAlignment";
import type { Alignment } from "../packages/pipeline-core/src/lib/elevenlabs";

/**
 * Exact beat timing from character timestamps.
 *
 * The alternative — re-running the character-weight predictor against the
 * measured segment length — looks like a measurement and is not one. It
 * assumes every character takes the same time, so a slowly delivered sentence
 * followed by a quick one puts the boundary in the wrong place and slides the
 * approved footage off the words it was approved against. These fixtures pin
 * the real conversion and every way it must refuse to guess.
 */

/** Alignment where character i occupies [i*step, (i+1)*step). */
function evenAlignment(text: string, step = 0.1): Alignment {
  const characters = [...text];
  return {
    characters,
    startTimes: characters.map((_, i) => +(i * step).toFixed(6)),
    endTimes: characters.map((_, i) => +((i + 1) * step).toFixed(6)),
  };
}

/** Alignment with a deliberate pause, so equal division would be wrong. */
function pausedAlignment(text: string, pauseAt: number, pause: number): Alignment {
  const characters = [...text];
  const startTimes: number[] = [], endTimes: number[] = [];
  let t = 0;
  characters.forEach((_, i) => {
    startTimes.push(+t.toFixed(6));
    t += 0.1 + (i === pauseAt ? pause : 0);
    endTimes.push(+t.toFixed(6));
  });
  return { characters, startTimes, endTimes };
}

const TEXT = "Alpha one. Beta two. Gamma three.";
const RANGES: BeatRange[] = [
  { beat: 1, startOffset: 0, endOffset: 11 },
  { beat: 2, startOffset: 11, endOffset: 21 },
  { beat: 3, startOffset: 21, endOffset: TEXT.length },
];

describe("beat spans tile a unit exactly", () => {
  const spans = beatSpansForUnit(TEXT, evenAlignment(TEXT), RANGES);

  test("the first beat starts at zero", () => assert.equal(spans[0]!.startS, 0));

  test("the last beat ends at the end of the audio", () => {
    assert.equal(spans[spans.length - 1]!.endS, +(TEXT.length * 0.1).toFixed(6));
  });

  test("no gaps and no overlaps", () => {
    for (let i = 1; i < spans.length; i++) {
      assert.equal(spans[i]!.startS, spans[i - 1]!.endS, `discontinuity before beat ${spans[i]!.beat}`);
    }
  });

  test("durations sum to the audio length", () => {
    const total = spans.reduce((a, s) => a + s.durationS, 0);
    assert.ok(Math.abs(total - TEXT.length * 0.1) < 1e-6);
  });

  test("boundaries land on the approved character offsets", () => {
    assert.ok(Math.abs(spans[0]!.endS - 1.1) < 1e-6, "beat 1 ends after 11 characters");
    assert.ok(Math.abs(spans[1]!.endS - 2.1) < 1e-6, "beat 2 ends after 21 characters");
  });

  test("order is preserved", () => {
    assert.deepEqual(spans.map((s) => s.beat), [1, 2, 3]);
  });
});

describe("real delivery, not equal division", () => {
  test("a pause inside beat 1 lengthens beat 1, not its neighbours", () => {
    const spans = beatSpansForUnit(TEXT, pausedAlignment(TEXT, 5, 2.0), RANGES);
    assert.ok(spans[0]!.durationS > 3.0, `beat 1 must absorb the pause, got ${spans[0]!.durationS}`);
    assert.ok(Math.abs(spans[1]!.durationS - 1.0) < 1e-6, "beat 2 is unaffected");
    // Equal division across the same total would have given every beat ~1.8s.
    const total = spans.reduce((a, s) => a + s.durationS, 0);
    assert.ok(Math.abs(spans[0]!.durationS - total / 3) > 1.0,
      "this fixture must distinguish the two methods for the test to mean anything");
  });
});

describe("whitespace, punctuation and the separator carry timings", () => {
  const withSep = "First unit body.\n\nSecond part here.";
  const ranges: BeatRange[] = [
    { beat: 1, startOffset: 0, endOffset: 18 },   // ends inside the "\n\n"
    { beat: 2, startOffset: 18, endOffset: withSep.length },
  ];
  test("a boundary inside the separator is honoured exactly", () => {
    const spans = beatSpansForUnit(withSep, evenAlignment(withSep), ranges);
    assert.ok(Math.abs(spans[0]!.endS - 1.8) < 1e-6);
    assert.equal(spans[1]!.startS, spans[0]!.endS);
  });
  test("every character including punctuation is covered exactly once", () => {
    const spans = beatSpansForUnit(withSep, evenAlignment(withSep), ranges);
    const total = spans.reduce((a, s) => a + s.durationS, 0);
    assert.ok(Math.abs(total - withSep.length * 0.1) < 1e-6);
  });
});

describe("decoded duration is honoured", () => {
  test("the last beat is extended to the real end of the audio", () => {
    // Encoder padding and trailing silence are small: ~26ms of MP3 delay plus
    // a little tail. 0.08s on 3.3s is realistic; 7% would not be.
    const actual = TEXT.length * 0.1 + 0.08;
    const spans = beatSpansForUnit(TEXT, evenAlignment(TEXT), RANGES, actual);
    assert.ok(Math.abs(spans[spans.length - 1]!.endS - actual) < 1e-6);
    const total = spans.reduce((a, s) => a + s.durationS, 0);
    assert.ok(Math.abs(total - actual) < 1e-6);
  });

  test("an implausible scale is a fault, not something to stretch over", () => {
    assert.throws(() => beatSpansForUnit(TEXT, evenAlignment(TEXT), RANGES, TEXT.length * 0.1 * 1.5),
      (e: Error) => e instanceof AlignmentError && /does not describe this audio/.test(e.message));
  });
});

describe("fails closed", () => {
  const A = evenAlignment(TEXT);

  test("malformed alignment", () => {
    for (const bad of [
      undefined, null, {}, { characters: [], startTimes: [], endTimes: [] },
      { characters: [...TEXT], startTimes: [1], endTimes: [1] },
    ]) {
      assert.throws(() => beatSpansForUnit(TEXT, bad as any, RANGES), AlignmentError, String(bad));
    }
  });

  test("character-count mismatch", () => {
    const short = evenAlignment(TEXT.slice(0, 10));
    assert.throws(() => beatSpansForUnit(TEXT, short, RANGES),
      (e: Error) => /character count does not match/.test(e.message));
  });

  test("characters that differ from the submitted text", () => {
    const wrong = evenAlignment(TEXT);
    wrong.characters[3] = "X";
    assert.throws(() => beatSpansForUnit(TEXT, wrong, RANGES),
      (e: Error) => /do not match the submitted text/.test(e.message));
  });

  test("non-finite and reversed timestamps", () => {
    const nan = evenAlignment(TEXT); nan.endTimes[2] = NaN;
    assert.throws(() => beatSpansForUnit(TEXT, nan, RANGES), /non-finite/);
    const rev = evenAlignment(TEXT); rev.endTimes[2] = rev.startTimes[2]! - 1;
    assert.throws(() => beatSpansForUnit(TEXT, rev, RANGES), /ends before it starts/);
  });

  test("ranges outside the unit", () => {
    assert.throws(() => beatSpansForUnit(TEXT, A, [{ beat: 1, startOffset: 0, endOffset: TEXT.length + 5 }]),
      /falls outside the unit/);
    assert.throws(() => beatSpansForUnit(TEXT, A, [{ beat: 1, startOffset: -1, endOffset: 5 }]),
      AlignmentError);
  });

  test("ranges that do not start at zero, leave a gap, overlap, or stop short", () => {
    assert.throws(() => beatSpansForUnit(TEXT, A, [{ beat: 1, startOffset: 2, endOffset: TEXT.length }]),
      /start at 2, not 0/);
    assert.throws(() => beatSpansForUnit(TEXT, A, [
      { beat: 1, startOffset: 0, endOffset: 10 }, { beat: 2, startOffset: 12, endOffset: TEXT.length }]),
      /previous beat ended at 10/);
    assert.throws(() => beatSpansForUnit(TEXT, A, [
      { beat: 1, startOffset: 0, endOffset: 12 }, { beat: 2, startOffset: 10, endOffset: TEXT.length }]),
      AlignmentError);
    assert.throws(() => beatSpansForUnit(TEXT, A, [{ beat: 1, startOffset: 0, endOffset: 10 }]),
      /cover 10 of 33 characters/);
  });

  test("an empty range", () => {
    assert.throws(() => beatSpansForUnit(TEXT, A, [
      { beat: 1, startOffset: 0, endOffset: 0 }, { beat: 2, startOffset: 0, endOffset: TEXT.length }]),
      /empty range/);
  });
});

describe("the whole narration concatenates exactly", () => {
  const t0 = "Unit zero text.", t1 = "Unit one text here.", t2 = "Unit two ends it.";
  const d = (t: string) => t.length * 0.1;
  const units = [
    { index: 0, text: t0, alignment: evenAlignment(t0), actualDurationS: d(t0), offsetS: 0 },
    { index: 1, text: t1, alignment: evenAlignment(t1), actualDurationS: d(t1), offsetS: d(t0) },
    { index: 2, text: t2, alignment: evenAlignment(t2), actualDurationS: d(t2), offsetS: d(t0) + d(t1) },
  ];
  const ranges = new Map<number, BeatRange[]>([
    [0, [{ beat: 1, startOffset: 0, endOffset: 8 }, { beat: 2, startOffset: 8, endOffset: t0.length }]],
    [1, [{ beat: 3, startOffset: 0, endOffset: t1.length }]],
    [2, [{ beat: 4, startOffset: 0, endOffset: 9 }, { beat: 5, startOffset: 9, endOffset: t2.length }]],
  ]);

  test("spans are contiguous across unit boundaries", () => {
    const spans = beatSpansForNarration(units, ranges);
    assert.equal(spans.length, 5);
    for (let i = 1; i < spans.length; i++) assert.equal(spans[i]!.startS, spans[i - 1]!.endS);
  });

  test("total equals the summed unit durations", () => {
    const spans = beatSpansForNarration(units, ranges);
    const total = spans[spans.length - 1]!.endS;
    assert.ok(Math.abs(total - (d(t0) + d(t1) + d(t2))) < 1e-6);
  });

  test("beats come back in beat order", () => {
    assert.deepEqual(beatSpansForNarration(units, ranges).map((s) => s.beat), [1, 2, 3, 4, 5]);
  });

  test("a unit with no ranges fails closed", () => {
    const missing = new Map(ranges); missing.delete(1);
    assert.throws(() => beatSpansForNarration(units, missing), /unit 1 has no beat ranges/);
  });

  test("an offset that does not follow the previous unit fails closed", () => {
    const bad = units.map((u) => (u.index === 2 ? { ...u, offsetS: u.offsetS! + 3 } : u));
    assert.throws(() => beatSpansForNarration(bad, ranges), /does not follow the previous unit/);
  });

  test("requires no second ElevenLabs call", () => {
    // Everything above is computed from the persisted alignment sidecars only.
    const spans = beatSpansForNarration(units, ranges);
    assert.equal(spans.length, 5);
  });
});
