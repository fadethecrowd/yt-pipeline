import type { Alignment } from "./elevenlabs";

/**
 * Turn ElevenLabs character timestamps into exact beat durations.
 *
 * Before this existed, the only way to time beats after narration was to
 * re-run the character-weight predictor against the measured segment length —
 * which is a prediction dressed up as a measurement. It divides a segment
 * proportionally and cannot know that one sentence was delivered slowly and
 * the next quickly, so a beat's footage drifts away from the words it was
 * approved against.
 *
 * The `/with-timestamps` response already carries the real answer: a start and
 * end time for every character actually spoken. A beat owns a half-open
 * character range, so its audio span is simply the time of its first character
 * to the time of its last. No estimation is involved.
 *
 * Every check here fails closed. A beat mistimed by a silently-tolerated
 * mismatch would put approved footage under the wrong words, which is exactly
 * the failure the v5 rebuild existed to eliminate.
 */

export class AlignmentError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "AlignmentError";
  }
}

export interface BeatRange {
  beat: number;
  /** Half-open character range within the spoken unit. */
  startOffset: number;
  endOffset: number;
}

export interface BeatSpan {
  beat: number;
  startS: number;
  endS: number;
  durationS: number;
}

/**
 * Beat spans for ONE spoken unit, in unit-relative seconds.
 *
 * `actualUnitDurationS` is the decoded length of the audio file. It differs
 * from the last character's end time by encoder padding and any trailing
 * silence, so the timeline is scaled onto it — otherwise the beats would
 * finish slightly before the audio does and the last beat would be short. The
 * scale factor is bounded; a large one means the alignment does not describe
 * this audio, which is a fault, not something to stretch over.
 */
export function beatSpansForUnit(
  unitText: string,
  alignment: Alignment,
  ranges: BeatRange[],
  actualUnitDurationS?: number,
  opts: { maxScaleDeviation?: number } = {},
): BeatSpan[] {
  const { characters, startTimes, endTimes } = alignment ?? ({} as Alignment);
  if (!Array.isArray(characters) || !Array.isArray(startTimes) || !Array.isArray(endTimes)) {
    throw new AlignmentError("alignment is missing its character or timing arrays");
  }
  if (characters.length === 0) throw new AlignmentError("alignment contains no characters");
  if (characters.length !== startTimes.length || characters.length !== endTimes.length) {
    throw new AlignmentError(
      "alignment arrays disagree in length",
      `chars=${characters.length} starts=${startTimes.length} ends=${endTimes.length}`,
    );
  }
  // The timestamps must describe the exact bytes submitted. Anything else and
  // the offsets stored against the approved text address different characters.
  const spoken = characters.join("");
  if (spoken.length !== unitText.length) {
    throw new AlignmentError(
      "alignment character count does not match the submitted text",
      `alignment=${spoken.length} submitted=${unitText.length}`,
    );
  }
  if (spoken !== unitText) {
    let i = 0; while (i < spoken.length && spoken[i] === unitText[i]) i += 1;
    throw new AlignmentError(
      "alignment characters do not match the submitted text",
      `first difference at ${i}: alignment ${JSON.stringify(spoken.slice(i, i + 20))} ` +
      `vs submitted ${JSON.stringify(unitText.slice(i, i + 20))}`,
    );
  }
  for (let i = 0; i < characters.length; i++) {
    if (!Number.isFinite(startTimes[i]) || !Number.isFinite(endTimes[i])) {
      throw new AlignmentError(`non-finite timestamp at character ${i}`);
    }
    if (endTimes[i]! < startTimes[i]! - 1e-9) {
      throw new AlignmentError(`character ${i} ends before it starts`);
    }
    if (i > 0 && startTimes[i]! < startTimes[i - 1]! - 1e-6) {
      throw new AlignmentError(`character ${i} starts before character ${i - 1}`);
    }
  }

  if (ranges.length === 0) throw new AlignmentError("no beat ranges supplied");
  const sorted = [...ranges].sort((a, b) => a.startOffset - b.startOffset);
  if (sorted[0]!.startOffset !== 0) {
    throw new AlignmentError(`beat ranges start at ${sorted[0]!.startOffset}, not 0`);
  }
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.endOffset <= r.startOffset) throw new AlignmentError(`beat ${r.beat}: empty range`);
    if (r.startOffset < 0 || r.endOffset > unitText.length) {
      throw new AlignmentError(
        `beat ${r.beat}: range [${r.startOffset},${r.endOffset}) falls outside the unit (${unitText.length} chars)`,
      );
    }
    if (i > 0 && r.startOffset !== sorted[i - 1]!.endOffset) {
      throw new AlignmentError(
        `beat ${r.beat}: range starts at ${r.startOffset} but the previous beat ended at ${sorted[i - 1]!.endOffset}`,
      );
    }
  }
  if (sorted[sorted.length - 1]!.endOffset !== unitText.length) {
    throw new AlignmentError(
      `beat ranges cover ${sorted[sorted.length - 1]!.endOffset} of ${unitText.length} characters`,
    );
  }

  const alignEnd = endTimes[endTimes.length - 1]!;
  if (!(alignEnd > 0)) throw new AlignmentError("alignment ends at or before zero");

  let scale = 1;
  if (actualUnitDurationS !== undefined) {
    if (!(actualUnitDurationS > 0)) throw new AlignmentError("actual unit duration must be positive");
    scale = actualUnitDurationS / alignEnd;
    const dev = Math.abs(scale - 1);
    const max = opts.maxScaleDeviation ?? 0.05;
    if (dev > max) {
      throw new AlignmentError(
        "alignment does not describe this audio",
        `decoded ${actualUnitDurationS.toFixed(3)}s vs alignment ${alignEnd.toFixed(3)}s (${(dev * 100).toFixed(2)}% apart)`,
      );
    }
  }
  const end = actualUnitDurationS ?? alignEnd;

  // Each beat runs from where the previous one stopped to the end of its last
  // character, so the spans tile the unit exactly: no gap can open between
  // them and none can overlap. Whitespace, punctuation and the "\n\n"
  // separator are ordinary characters and carry their own timings.
  const spans: BeatSpan[] = [];
  let cursor = 0;
  sorted.forEach((r, i) => {
    const last = i === sorted.length - 1;
    const endS = last ? end : Math.min(end, endTimes[r.endOffset - 1]! * scale);
    if (endS < cursor - 1e-9) {
      throw new AlignmentError(`beat ${r.beat}: audio boundary moves backwards`);
    }
    spans.push({ beat: r.beat, startS: +cursor.toFixed(6), endS: +endS.toFixed(6),
                 durationS: +(endS - cursor).toFixed(6) });
    cursor = endS;
  });
  return spans;
}

export interface UnitInput {
  index: number;
  text: string;
  alignment: Alignment;
  /** Decoded audio length, and the offset of this unit inside the full track. */
  actualDurationS?: number;
  offsetS?: number;
}

/**
 * Beat spans for the whole narration, in absolute track seconds.
 *
 * Units are laid end to end using the offsets the narration manifest recorded
 * when the track was assembled, so the result matches the audio the renderer
 * will mux rather than a re-derived guess at it.
 */
export function beatSpansForNarration(
  units: UnitInput[],
  rangesByUnit: Map<number, BeatRange[]>,
): BeatSpan[] {
  if (units.length === 0) throw new AlignmentError("no spoken units supplied");
  const out: BeatSpan[] = [];
  let clock = 0;
  for (const u of [...units].sort((a, b) => a.index - b.index)) {
    const ranges = rangesByUnit.get(u.index);
    if (!ranges || ranges.length === 0) {
      throw new AlignmentError(`unit ${u.index} has no beat ranges`);
    }
    const base = u.offsetS ?? clock;
    if (Math.abs(base - clock) > 0.05) {
      throw new AlignmentError(
        `unit ${u.index} offset ${base.toFixed(3)}s does not follow the previous unit ending at ${clock.toFixed(3)}s`,
      );
    }
    const spans = beatSpansForUnit(u.text, u.alignment, ranges, u.actualDurationS);
    for (const s of spans) {
      out.push({ beat: s.beat, startS: +(base + s.startS).toFixed(6),
                 endS: +(base + s.endS).toFixed(6), durationS: s.durationS });
    }
    clock = base + spans[spans.length - 1]!.endS;
  }
  out.sort((a, b) => a.beat - b.beat);
  // Contiguity across the whole track, proven rather than assumed. The
  // tolerance is a millisecond: spans are rounded to microseconds on both
  // sides of a unit join, so an exact comparison rejects float noise a
  // thousand times smaller than a single video frame.
  const JOIN_TOLERANCE_S = 1e-3;
  for (let i = 1; i < out.length; i++) {
    if (Math.abs(out[i]!.startS - out[i - 1]!.endS) > JOIN_TOLERANCE_S) {
      throw new AlignmentError(
        `beat ${out[i]!.beat} starts at ${out[i]!.startS}s but beat ${out[i - 1]!.beat} ended at ${out[i - 1]!.endS}s`,
      );
    }
  }
  return out;
}
