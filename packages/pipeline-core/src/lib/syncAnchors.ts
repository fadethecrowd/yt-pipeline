import type { Cue, Word } from "./captions";

/**
 * Natural synchronisation anchors.
 *
 * The first diagnostics spoke "marker one / two / three" so alignment could be
 * located by ear. That worked, but it is an artefact that must never reach
 * publishable content, and it made the diagnostic sound unlike a real video.
 *
 * Anchors are now ordinary sentences chosen from the script itself — one near
 * the beginning, one near the middle, one near the end. Their text and aligned
 * timestamps are recorded in the QA record, so synchronisation is still
 * measurable at three points without saying anything unnatural.
 */

/** Phrases that betray a diagnostic artefact in narration or metadata. */
export const DIAGNOSTIC_MARKER_PATTERNS: RegExp[] = [
  /\bmarker\s+(one|two|three|1|2|3)\b/i,
  /\b(timing|sync|test)\s+marker\b/i,
  /\bthree seconds in\b/i,
  /\bmiddle of the run\b/i,
  /\bnear the end\b(?=[.,])/i,
];

/**
 * Detect diagnostic marker phrases. Used to keep them out of qualification and
 * production scripts, titles, descriptions and captions.
 */
export function findDiagnosticMarkers(text: string): string[] {
  const found: string[] = [];
  for (const re of DIAGNOSTIC_MARKER_PATTERNS) {
    const m = text.match(re);
    if (m) found.push(m[0]);
  }
  return found;
}

export function containsDiagnosticMarkers(text: string): boolean {
  return findDiagnosticMarkers(text).length > 0;
}

export interface SyncAnchor {
  position: "beginning" | "middle" | "end";
  /** The natural phrase used as the anchor. */
  phrase: string;
  /** When the phrase is spoken, from the alignment. */
  audioStartS: number;
  /** When the caption containing it appears. */
  captionStartS: number;
  /** captionStart − audioStart. Positive means the caption lags. */
  offsetS: number;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s']/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Find the word index where `phrase` begins, or -1.
 * Matches on normalized tokens so punctuation differences do not defeat it.
 */
export function locatePhrase(words: Word[], phrase: string): number {
  const target = normalize(phrase).split(" ").filter(Boolean);
  if (target.length === 0) return -1;
  const spoken = words.map((w) => normalize(w.text));
  for (let i = 0; i + target.length <= spoken.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (spoken[i + j] !== target[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Choose three natural anchor phrases spread across the narration and measure
 * caption alignment at each.
 *
 * @param anchorPhrases optional explicit phrases (from the script author);
 *                      when omitted, phrases are derived from the words
 *                      themselves at the 10%, 50% and 90% marks.
 */
export function extractSyncAnchors(
  words: Word[],
  cues: Cue[],
  anchorPhrases?: { beginning: string; middle: string; end: string },
): SyncAnchor[] {
  if (words.length === 0 || cues.length === 0) return [];

  const pick = (frac: number, len = 4): string => {
    const start = Math.min(
      Math.max(0, Math.floor(words.length * frac)),
      Math.max(0, words.length - len),
    );
    return words.slice(start, start + len).map((w) => w.text).join(" ");
  };

  const chosen: [SyncAnchor["position"], string][] = anchorPhrases
    ? [
        ["beginning", anchorPhrases.beginning],
        ["middle", anchorPhrases.middle],
        ["end", anchorPhrases.end],
      ]
    : [
        ["beginning", pick(0.05)],
        ["middle", pick(0.5)],
        ["end", pick(0.9)],
      ];

  const anchors: SyncAnchor[] = [];
  for (const [position, phrase] of chosen) {
    const idx = locatePhrase(words, phrase);
    if (idx < 0) continue;
    const w = words[idx];
    // The cue that should be on screen when this word is spoken.
    const cue =
      cues.find((c) => w.start >= c.start - 1e-6 && w.start < c.end) ??
      cues.reduce((best, c) =>
        Math.abs(c.start - w.start) < Math.abs(best.start - w.start) ? c : best,
      );
    // Offset is measured against the cue that introduces this word: the first
    // cue whose text contains it.
    const introducing = cues.find((c) => normalize(c.text).startsWith(normalize(w.text))) ?? cue;
    anchors.push({
      position,
      phrase,
      audioStartS: w.start,
      captionStartS: cue.start,
      offsetS: (introducing === cue ? cue.start : introducing.start) - w.start,
    });
  }
  return anchors;
}

export function formatAnchors(anchors: SyncAnchor[]): string {
  if (anchors.length === 0) return "  (no anchors located)";
  return anchors
    .map(
      (a) =>
        `  ${a.position.padEnd(9)} "${a.phrase}"\n` +
        `${" ".repeat(12)}spoken ${a.audioStartS.toFixed(2)}s | caption ${a.captionStartS.toFixed(2)}s | offset ${(a.offsetS * 1000).toFixed(0)}ms`,
    )
    .join("\n");
}
