import type { Word } from "./captions";

/**
 * Visual beat planning.
 *
 * The pipeline used to render exactly one clip per script segment. Segments run
 * 75–120 s, so a 20 s stock clip was stretched with `-stream_loop` to cover
 * them — the opening clip of AI Doom qualification #1 repeated for roughly two
 * minutes. Footage quality was never the problem; duration and repetition were.
 *
 * A segment is now divided into BEATS at sentence boundaries taken from the
 * real word alignment, each 15–25 s, hard-capped at 30 s. Every beat gets its
 * own unique asset, cut (never looped) to the beat's exact length.
 */

/** Preferred length of a single visual. */
export const BEAT_TARGET_S = 19;
/** Beats shorter than this are merged into their neighbour. */
export const BEAT_MIN_S = 8;
/** Hard ceiling for ordinary stock footage. Exceeding this fails QA. */
export const BEAT_MAX_S = 30;
/**
 * Shortest usable fragment of a beat. A beat may be covered by several
 * consecutive fragments, each from a different asset; below this length a cut
 * reads as a flash rather than a shot.
 *
 * Assembly and the pre-TTS feasibility gate must agree on this number — the
 * gate predicts how many unique assets assembly will need, and that prediction
 * is only meaningful if both use the same minimum fragment.
 */
export const MIN_FRAGMENT_S = 6;

/**
 * Decide how much of a source clip to use for the unfilled part of a beat.
 *
 * Returns null when this source cannot be used here — the caller should try a
 * different asset rather than accept a bad fit.
 *
 * The rule that matters is the third case. Taking as much as the source allows
 * can leave a remainder too short to be its own fragment: a beat with 8.6s left
 * and an 8.0s clip leaves 0.6s, which is not enough for another shot and
 * therefore became a 0.6-SECOND BRANDED CARD. The HBM qualification asset
 * carried ten of these — two thirds of its fallback cards were sub-six-second
 * slivers produced by arithmetic, not by any shortage of footage.
 *
 * The previous implementation tried to avoid exactly this and was defeated by
 * its own final clamp: it set `useDur = remaining` to close the beat, then
 * immediately clamped back to the source duration, restoring the sliver. When
 * a source genuinely cannot close the beat, the fix is to take LESS from it and
 * leave a remainder that a further unique asset can fill.
 */
export function fitFragment(
  remainingS: number,
  sourceDurationS: number,
): { useS: number } | null {
  const cap = Math.min(remainingS, sourceDurationS, BEAT_MAX_S);
  if (cap < MIN_FRAGMENT_S) return null;

  const leftover = remainingS - cap;
  // Exact fit, or a remainder another fragment can cover.
  if (leftover <= 0.01 || leftover >= MIN_FRAGMENT_S) return { useS: cap };

  // The source is long enough to close the beat outright.
  if (sourceDurationS >= remainingS && remainingS <= BEAT_MAX_S) {
    return { useS: remainingS };
  }

  // It is not. Take less, so what is left is a usable fragment rather than a
  // sliver. Never loop, never freeze, never stretch to cover the difference.
  const reduced = remainingS - MIN_FRAGMENT_S;
  if (reduced >= MIN_FRAGMENT_S) return { useS: reduced };

  // Nothing this source can do here without leaving a sliver.
  return null;
}


/**
 * Longest a single outro card may hold the screen.
 *
 * Tied to the mechanical QA gate, not to taste: `MAX_FROZEN_RUN_S` in lib/qa.ts
 * is 4.0s, and an outro card is a genuinely static frame, so any card longer
 * than that is a frozen run the gate will flag. Run c28dd19c held 6.73s and
 * 7.53s cards and drew `[WARN] no_frozen_sections: longest frozen run 5.13s` —
 * every frozen run in that render fell inside the outro span.
 *
 * Deliberately NOT MIN_FRAGMENT_S. That floor exists because a stock-footage
 * cut shorter than six seconds reads as a flash; a text card is not footage,
 * and the title card has always held for exactly 4.0s.
 *
 * A test asserts this stays at or under MAX_FROZEN_RUN_S so the two cannot
 * drift apart.
 */
export const OUTRO_CARD_MAX_S = 4.0;

/**
 * How to split an outro beat across several cards.
 *
 * The outro is deterministic and has no subject to retrieve, so it is cards —
 * but the first version held ONE card for the whole beat, which was 19 seconds
 * of an unchanging frame on run e704334a. Motion is no help on a flat colour
 * field: a slow zoom over solid navy is invisible, so the only thing that can
 * actually change is the text.
 *
 * Cards therefore cut often enough that no single one becomes a frozen run.
 * The count follows from the duration alone; the caller cycles its lines to
 * fill it. The last card absorbs rounding so the cards tile the beat exactly.
 */
export function outroCardPlan(durationS: number): number[] {
  if (!Number.isFinite(durationS) || durationS <= 0) return [];
  const count = Math.max(1, Math.ceil(durationS / OUTRO_CARD_MAX_S));
  const slice = durationS / count;
  const out = Array.from({ length: count }, () => slice);
  out[count - 1] = +(durationS - slice * (count - 1)).toFixed(6);
  return out;
}

export interface VisualBeat {
  index: number;
  /** Start on the narration timeline (excludes the title card). */
  startS: number;
  endS: number;
  durationS: number;
  /** The words spoken during this beat — used for relevance scoring. */
  narration: string;
  /** Which script segment this beat came from. */
  segmentIndex: number;
}

function endsSentence(w: string): boolean {
  return /[.!?](["')\]]+)?$/.test(w);
}

/**
 * Split one segment's words into beats at sentence boundaries.
 *
 * Boundaries are only taken where the speaker actually finished a sentence, so
 * a visual change never lands mid-thought. When a single sentence runs past
 * BEAT_MAX_S it is split at the nearest word boundary instead — a long
 * sentence must still not hold one clip on screen for 30+ seconds.
 */
export function planSegmentBeats(
  words: Word[],
  segmentIndex: number,
  startIndex = 0,
): VisualBeat[] {
  if (words.length === 0) return [];

  const beats: VisualBeat[] = [];
  let current: Word[] = [];
  let beatStart = words[0].start;

  const flush = (force = false) => {
    if (current.length === 0) return;
    const start = beatStart;
    const end = current[current.length - 1].end;
    // A short remainder is merged into the previous beat rather than flashing
    // on screen — including on the final flush, where `force` only means
    // "emit what is left", not "emit it however short".
    if (end - start < BEAT_MIN_S && beats.length > 0) {
      // Too short to stand alone — extend the previous beat instead, unless
      // that would push it past the hard cap.
      //
      // `force` used to override the cap here, which is how a final remainder
      // merged into a nearly-full beat produced 30.7s against a 30s assembly
      // contract — after narration had already been bought. A slightly short
      // closing beat is a pacing imperfection; an over-cap beat is a rejected
      // candidate, so the cap wins and the remainder stands alone.
      const prev = beats[beats.length - 1];
      if (end - prev.startS <= BEAT_MAX_S) {
        prev.endS = end;
        prev.durationS = end - prev.startS;
        prev.narration = `${prev.narration} ${current.map((w) => w.text).join(" ")}`.trim();
        current = [];
        beatStart = end;
        return;
      }
    }
    beats.push({
      index: 0, // assigned by the caller
      startS: start,
      endS: end,
      durationS: end - start,
      narration: current.map((w) => w.text).join(" "),
      segmentIndex,
    });
    current = [];
    beatStart = end;
  };

  for (const w of words) {
    // Cut BEFORE the word that would breach the cap, not after.
    //
    // The check used to run once the word was already in the beat, so a beat
    // ended at whatever the overshooting word's end happened to be — 38.5s in
    // the worst reproduction. Deciding first means the emitted beat is always
    // the last one that still fits, and the long word opens the next beat.
    if (current.length > 0 && w.end - beatStart > BEAT_MAX_S) {
      flush(true);
    }
    current.push(w);
    const span = w.end - beatStart;

    if (span >= BEAT_TARGET_S && endsSentence(w.text)) {
      flush();
      continue;
    }
    // A sentence that ends comfortably past the minimum is a natural cut.
    if (span >= BEAT_MIN_S * 1.5 && endsSentence(w.text) && span >= BEAT_TARGET_S * 0.75) {
      flush();
    }
  }
  flush(true);

  void startIndex;
  return beats;
}

/**
 * Plan beats for the whole video from the per-segment word alignments.
 *
 * @param segmentWords words for each segment, already offset onto the
 *                     narration timeline
 */
export function planVisualBeats(segmentWords: Word[][]): VisualBeat[] {
  const all: VisualBeat[] = [];
  segmentWords.forEach((words, segmentIndex) => {
    for (const b of planSegmentBeats(words, segmentIndex)) all.push(b);
  });
  return all.map((b, i) => ({ ...b, index: i + 1 }));
}

export interface BeatPlanSummary {
  count: number;
  averageS: number;
  maxS: number;
  minS: number;
  overCap: VisualBeat[];
}

export function summarizeBeats(beats: VisualBeat[]): BeatPlanSummary {
  if (beats.length === 0) {
    return { count: 0, averageS: 0, maxS: 0, minS: 0, overCap: [] };
  }
  const durations = beats.map((b) => b.durationS);
  return {
    count: beats.length,
    averageS: durations.reduce((a, b) => a + b, 0) / beats.length,
    maxS: Math.max(...durations),
    minS: Math.min(...durations),
    overCap: beats.filter((b) => b.durationS > BEAT_MAX_S + 0.5),
  };
}

/**
 * Expected number of visual changes for a runtime — used as a blocking QA
 * floor so a sparse timeline cannot pass again.
 */
export function minimumBeatsFor(narrationS: number): number {
  return Math.max(3, Math.floor(narrationS / BEAT_MAX_S));
}
