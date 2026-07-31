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
      const prev = beats[beats.length - 1];
      if (end - prev.startS <= BEAT_MAX_S || force) {
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
    current.push(w);
    const span = w.end - beatStart;

    if (span >= BEAT_MAX_S) {
      // Hard cap reached mid-sentence — cut here rather than run long.
      flush(true);
      continue;
    }
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
