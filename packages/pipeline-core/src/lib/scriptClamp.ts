/**
 * Deterministic length control for narration.
 *
 * The model cannot be trusted to obey a character budget. Measured live on
 * 2026-08-16, asked to shorten a 7,342-character script against a 5,925 limit,
 * it returned 7,904 — longer than what it was given. A second, budgeted
 * generation returned 6,911. Three model attempts, never once inside the
 * envelope, and an authorized production attempt spent on the argument.
 *
 * So length stops being negotiated. The model writes; this counts and cuts.
 *
 * Cutting happens on sentence boundaries only, so no word is ever severed and
 * no dangling punctuation is produced. It can make prose worse — that is
 * acceptable and deliberate, because `qualityGate` runs afterwards and is the
 * thing that decides whether the result is still good enough. A candidate
 * damaged by trimming fails there, which is a far better outcome than another
 * round of asking.
 */

/** Sentence boundary: terminal punctuation followed by whitespace. */
const BOUNDARY = /(?<=[.!?])\s+/;

/**
 * Split into sentences, preserving punctuation and dropping nothing.
 *
 * Joining the result with a single space reproduces the input up to
 * whitespace, so trimming can only ever remove whole sentences.
 */
export function splitSentences(text: string): string[] {
  return text.split(BOUNDARY).map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface TrimResult {
  text: string;
  /** Sentences removed. Zero means the input was already inside the limit. */
  removed: number;
  /** True when the limit was reached. False means it could not be, without cutting a word. */
  ok: boolean;
}

/**
 * Remove whole sentences until the text fits, or report that it cannot.
 *
 * `keepLast` protects a closing line — the CTA lives at the end of the final
 * segment, so trimming from the tail there would delete the one sentence the
 * script needs to keep. In that mode sentences are removed from just before
 * the end instead, so the opening and closing lines both survive.
 *
 * Never returns an empty string: a single sentence over the limit is returned
 * unchanged with `ok: false`, and the caller must fail the candidate rather
 * than ship it or cut mid-word.
 */
export function trimToLimit(
  text: string,
  limitChars: number,
  opts: { keepLast?: boolean } = {},
): TrimResult {
  const trimmed = text.trim();
  if (trimmed.length <= limitChars) return { text: trimmed, removed: 0, ok: true };

  const sentences = splitSentences(trimmed);
  if (sentences.length <= 1) return { text: trimmed, removed: 0, ok: false };

  const kept = [...sentences];
  let removed = 0;
  // Always leave at least one sentence, and two when the closing line is being
  // protected, so `keepLast` cannot collapse to the CTA alone.
  const floor = opts.keepLast ? 2 : 1;
  while (kept.length > floor && kept.join(" ").length > limitChars) {
    // Tail by default; second-to-last when a closing sentence must survive.
    kept.splice(opts.keepLast ? kept.length - 2 : kept.length - 1, 1);
    removed++;
  }

  let out = kept.join(" ");
  // With `keepLast`, two sentences may still exceed the limit. Dropping the
  // opening is worse than dropping the close, so the close goes last.
  if (out.length > limitChars && opts.keepLast && kept.length === 2) {
    kept.pop();
    removed++;
    out = kept.join(" ");
  }
  return { text: out, removed, ok: out.length <= limitChars };
}
