import type { Word } from "./captions";

/**
 * Shorts hook-window resolution.
 *
 * The clip window used to come from `hookSegment`, whose timestamps were
 * derived from the script's ESTIMATED `duration_seconds` at an assumed
 * 2.5 words/second. The real narration never matches that estimate, so the
 * Short could start or end mid-word and its captions were laid over a window
 * that did not correspond to the audio.
 *
 * The window is now resolved against the narration manifest's real word
 * timings: the requested hook text is located in the actual spoken words, and
 * the window is snapped outward to word boundaries. If the hook cannot be
 * located, resolution FAILS — it never silently falls back to a
 * words-per-minute estimate.
 */

export interface HookWindow {
  /** Start on the video timeline (already includes the title-card offset). */
  startS: number;
  /** End on the video timeline. */
  endS: number;
  durationS: number;
  /** Words actually inside the window, with real times. */
  words: Word[];
  /** Text as spoken in the window. */
  text: string;
  firstWordIndex: number;
  lastWordIndex: number;
  /** How much of the requested hook text was matched, 0..1. */
  matchRatio: number;
}

export class HookAlignmentError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`Hook could not be aligned to the final audio: ${reason}. ${detail}`);
    this.name = "HookAlignmentError";
  }
}

/** Comparison form: lowercase, letters/digits/apostrophes only. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']+/g, "");
}

/**
 * Locate `hookText` inside `words` and return the matching index range.
 *
 * Uses a longest-run alignment rather than exact equality, because the spoken
 * narration is the hook folded into segment 0 and may differ in punctuation or
 * have the CTA appended elsewhere.
 */
function locateHook(
  words: Word[],
  hookText: string,
): { first: number; last: number; matched: number; total: number } | null {
  const target = hookText.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (target.length === 0) return null;

  const spoken = words.map((w) => normalizeToken(w.text));

  // Find the best starting offset by counting in-order matches.
  let bestStart = -1;
  let bestMatched = 0;
  let bestEnd = -1;

  const searchLimit = Math.min(spoken.length, 400);
  for (let start = 0; start < searchLimit; start++) {
    if (spoken[start] !== target[0]) continue;
    let ti = 0;
    let si = start;
    let matched = 0;
    let lastSi = start;
    // Walk forward allowing small skips on either side for punctuation-only
    // or dropped tokens.
    while (ti < target.length && si < spoken.length && si - start < target.length + 40) {
      if (spoken[si] === target[ti]) {
        matched++;
        lastSi = si;
        ti++;
        si++;
      } else if (spoken[si + 1] === target[ti]) {
        si++;
      } else {
        ti++;
      }
    }
    if (matched > bestMatched) {
      bestMatched = matched;
      bestStart = start;
      bestEnd = lastSi;
    }
  }

  if (bestStart < 0 || bestMatched === 0) return null;
  return { first: bestStart, last: bestEnd, matched: bestMatched, total: target.length };
}

export interface ResolveHookOptions {
  /** Real word timings for the whole narration, on the video timeline. */
  words: Word[];
  /** The hook text the script asked to clip. */
  hookText: string;
  /** Hard cap on the Short's narration length. */
  maxDurationS: number;
  /** Refuse to produce a Short shorter than this. */
  minDurationS: number;
  /** Minimum fraction of the requested hook that must be found in the audio. */
  minMatchRatio?: number;
}

/**
 * Resolve the Short's clip window from real audio timings.
 *
 * Guarantees on success:
 *  - start is exactly a word's start time (never mid-word)
 *  - end is exactly a word's end time (never mid-word)
 *  - the window ends on a sentence boundary when one fits inside maxDuration
 *  - captions and visuals both derive from this single window
 *
 * Throws HookAlignmentError when the hook is absent, too short, or too poorly
 * matched to trust. Callers must treat that as "skip the Short", never as
 * "fall back to an estimate".
 */
export function resolveHookWindow(opts: ResolveHookOptions): HookWindow {
  const { words, hookText, maxDurationS, minDurationS, minMatchRatio = 0.6 } = opts;

  if (words.length === 0) {
    throw new HookAlignmentError("no narration words", "The narration manifest produced no timed words.");
  }
  if (!hookText || hookText.trim().length === 0) {
    throw new HookAlignmentError("empty hook text", "hookSegment carried no text to locate.");
  }

  const located = locateHook(words, hookText);
  if (!located) {
    throw new HookAlignmentError(
      "hook text not found in final audio",
      `Looked for "${hookText.slice(0, 80)}…" across ${words.length} spoken words.`,
    );
  }

  const matchRatio = located.matched / located.total;
  if (matchRatio < minMatchRatio) {
    throw new HookAlignmentError(
      `hook match ratio ${matchRatio.toFixed(2)} below ${minMatchRatio}`,
      `Only ${located.matched} of ${located.total} hook words were found in the narration.`,
    );
  }

  const first = located.first;
  const startS = words[first].start;

  // Extend to the last word that fits inside maxDuration, preferring the last
  // sentence-ending word so the Short does not stop mid-thought.
  let last = first;
  let lastSentenceEnd = -1;
  for (let i = first; i <= located.last && i < words.length; i++) {
    if (words[i].end - startS > maxDurationS) break;
    last = i;
    if (/[.!?](["')\]]+)?$/.test(words[i].text)) lastSentenceEnd = i;
  }
  if (lastSentenceEnd > first) {
    const sentenceDur = words[lastSentenceEnd].end - startS;
    if (sentenceDur >= minDurationS) last = lastSentenceEnd;
  }

  const endS = words[last].end;
  const durationS = endS - startS;

  if (durationS < minDurationS) {
    throw new HookAlignmentError(
      `resolved window ${durationS.toFixed(2)}s shorter than ${minDurationS}s`,
      `Hook spans words ${first}..${last} (${startS.toFixed(2)}s–${endS.toFixed(2)}s).`,
    );
  }

  const inWindow = words.slice(first, last + 1);
  return {
    startS,
    endS,
    durationS,
    words: inWindow,
    text: inWindow.map((w) => w.text).join(" "),
    firstWordIndex: first,
    lastWordIndex: last,
    matchRatio,
  };
}

/**
 * Confirm the resolved window really is bounded by word edges and contains no
 * partial word. Cheap invariant check run before rendering.
 */
export function validateHookWindow(w: HookWindow, allWords: Word[]): void {
  const startsOnWord = allWords.some((x) => Math.abs(x.start - w.startS) < 1e-6);
  const endsOnWord = allWords.some((x) => Math.abs(x.end - w.endS) < 1e-6);
  if (!startsOnWord) {
    throw new HookAlignmentError("window start is not a word boundary", `startS=${w.startS}`);
  }
  if (!endsOnWord) {
    throw new HookAlignmentError("window end is not a word boundary", `endS=${w.endS}`);
  }
  const straddling = allWords.filter(
    (x) => (x.start < w.startS && x.end > w.startS) || (x.start < w.endS && x.end > w.endS),
  );
  if (straddling.length > 0) {
    throw new HookAlignmentError(
      "window cuts through a word",
      `${straddling.length} word(s) straddle the window edges, e.g. "${straddling[0].text}"`,
    );
  }
}
