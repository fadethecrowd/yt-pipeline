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
  /** True when the limit was reached. False only when it cannot hold one word. */
  ok: boolean;
}

/** Terminal punctuation, or the clause marks a cut can legitimately land on. */
const CLAUSE_MARKS = /[.!?;:—,]/g;

/**
 * Tidy a cut so it reads as a finished sentence.
 *
 * Drops a dangling comma, semicolon, colon or dash left by cutting mid-clause,
 * then supplies a full stop if the text does not already end in terminal
 * punctuation. Never adds a word.
 */
function normalizeEnd(text: string): string {
  const t = text.trim().replace(/[\s,;:—–-]+$/u, "").trim();
  if (t.length === 0) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Cut inside a single sentence that is itself over the limit.
 *
 * Latest usable clause boundary first, so the result ends where the writing
 * already paused; otherwise the longest prefix of whole words. Every candidate
 * is normalised and then MEASURED, because normalising can add a character —
 * so the returned string is always within the limit or empty.
 *
 * Empty is returned only when the limit cannot hold a single word, which the
 * caller treats as a failure rather than shipping a fragment.
 */
function clampWithinSentence(text: string, limitChars: number): string {
  if (text.length <= limitChars) return text;

  const window = text.slice(0, limitChars + 1);
  const marks: number[] = [];
  CLAUSE_MARKS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_MARKS.exec(window)) !== null) marks.push(m.index);
  for (let i = marks.length - 1; i >= 0; i--) {
    const cand = normalizeEnd(text.slice(0, marks[i]! + 1));
    if (cand.length > 0 && cand.length <= limitChars) return cand;
  }

  // No clause break early enough: take whole words.
  let cut = text.lastIndexOf(" ", limitChars);
  while (cut > 0) {
    const cand = normalizeEnd(text.slice(0, cut));
    if (cand.length > 0 && cand.length <= limitChars) return cand;
    cut = text.lastIndexOf(" ", cut - 1);
  }
  return "";
}

/**
 * Bring text inside a hard character limit, preferring the largest structure.
 *
 * Three levels, in order, and the last one always succeeds:
 *
 *   1. remove whole trailing sentences
 *   2. cut the remaining sentence at its latest clause boundary that fits
 *   3. cut at the latest word boundary that fits
 *
 * `keepLast` biases step 1 toward protecting a closing line — the CTA sits at
 * the end of the final segment — by removing sentences from just before the
 * end. It is a PREFERENCE, not a constraint: an earlier version treated it as
 * one and returned an over-limit segment rather than touch the close, which is
 * exactly the refusal this fixes. Numeric compliance always wins; whether the
 * result still reads well is `qualityGate`'s decision, not this function's.
 *
 * Never splits a word. Never returns text over the limit.
 */
export function trimToLimit(
  text: string,
  limitChars: number,
  opts: { keepLast?: boolean } = {},
): TrimResult {
  const trimmed = text.trim();
  if (trimmed.length <= limitChars) return { text: trimmed, removed: 0, ok: true };

  // 1. Whole sentences.
  const kept = splitSentences(trimmed);
  let removed = 0;
  const floor = opts.keepLast ? 2 : 1;
  while (kept.length > floor && kept.join(" ").length > limitChars) {
    kept.splice(opts.keepLast ? kept.length - 2 : kept.length - 1, 1);
    removed++;
  }
  // The protected close cannot keep the segment over the limit.
  while (kept.length > 1 && kept.join(" ").length > limitChars) {
    kept.pop();
    removed++;
  }

  const out = kept.join(" ");
  if (out.length <= limitChars) return { text: out, removed, ok: true };

  // 2/3. One sentence, still too long: cut inside it.
  const clamped = clampWithinSentence(out, limitChars);
  return { text: clamped, removed, ok: clamped.length > 0 && clamped.length <= limitChars };
}
