import { buildSpokenUnits } from "./spokenUnits";
import type { ScriptLike } from "./spokenUnits";

/**
 * Structural defects that would be SPOKEN, checked before anything is bought.
 *
 * Run e704334a shipped a video whose opening was read twice. The chain:
 *
 *   1. `foldHookAndCtaIntoSegments` prepends the hook into segment 0's
 *      narration, so the two are deliberately the same text.
 *   2. `enforceScriptLength` trims that narration to fit its budget, cutting
 *      the hook part-way through.
 *   3. `buildSpokenUnits` asks `alreadyContains(narration, hook)`. It is now
 *      false — the narration holds only a PREFIX of the hook — so the whole
 *      hook is pushed back in front of it.
 *
 * The listener hears the opening, then hears it again. Same mechanism at the
 * other end for the CTA. The quality gate noticed and subtracted points; at
 * 76/100 against a threshold of 75 the candidate proceeded and was voiced.
 *
 * Structure is not a matter of degree, so it is not scored. A duplicated
 * sentence is wrong at 90/100 exactly as it is at 60.
 *
 * Repair only where the answer is unambiguous — the segment exactly contains
 * the part, or begins with a prefix of it — because both cases have one
 * correct edit: remove the span the unit builder is about to re-add. Anything
 * else is rejected rather than guessed at.
 */

/** lowercase, strip punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

const tokens = (s: string): string[] => normalize(s).split(" ").filter(Boolean);

/** Overlap of two token multisets, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const n = counts.get(t) ?? 0;
    if (n > 0) { shared++; counts.set(t, n - 1); }
  }
  return shared / Math.max(ta.length, tb.length);
}

export const NEAR_DUPLICATE_SIMILARITY = 0.85;
const LEAD_CHARS = 120;
/**
 * Shortest leading overlap worth treating as duplication.
 *
 * Two pieces of prose about the same subject share short openings by
 * coincidence — "The " or "And so" — and flagging those would reject clean
 * scripts. A full clause is the smallest overlap that cannot be accidental.
 */
const MIN_MEANINGFUL_OVERLAP = 40;

export interface StructureIssue {
  code: "HOOK_DUPLICATED" | "CTA_DUPLICATED" | "SENTENCE_REPEATED";
  detail: string;
  repaired: boolean;
}

export interface StructureResult {
  ok: boolean;
  issues: StructureIssue[];
  /** Rejection reasons; empty when everything was either clean or repaired. */
  rejections: string[];
}

/**
 * Drop repeated sentences that belong to a dedicated field, keeping the last.
 *
 * The model writes outro boilerplate — "I read every comment" — into the body
 * of the final segment as well as it living in the CTA field. Folding then
 * places the field's copy after it, and the line is spoken twice. The dedicated
 * field is canonical, and folding puts it last, so the earlier copy is the one
 * that goes. Sentence-aligned, so nothing is left dangling.
 */
function dedupeFieldSentences(narration: string, part: string): string | null {
  if (!part) return null;
  const sentences = narration.split(/(?<=[.!?])\s+/);
  const np = normalize(part);
  const counts = new Map<string, number>();
  for (const x of sentences) {
    const n = normalize(x);
    if (n.split(" ").length >= 5 && np.includes(n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const repeated = new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
  if (repeated.size === 0) return null;
  const lastIndex = new Map<string, number>();
  sentences.forEach((x, i) => { const n = normalize(x); if (repeated.has(n)) lastIndex.set(n, i); });
  const kept = sentences.filter((x, i) => {
    const n = normalize(x);
    return !repeated.has(n) || lastIndex.get(n) === i;
  });
  const out = kept.join(" ").trim();
  return out.length > 0 && out !== narration ? out : null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/**
 * Drop every occurrence of `part` except the last.
 *
 * The dedicated field is canonical and folding places it at the end, so the
 * copy the model wrote into the body is the one to remove. Sentence-aligned, so
 * no fragment is left behind.
 */
function stripEarlierOccurrence(narration: string, part: string): string | null {
  const sentences = narration.split(/(?<=[.!?])\s+/);
  const np = normalize(part);
  const hits: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (np.includes(normalize(sentences[i]!)) && normalize(sentences[i]!).length > 0) hits.push(i);
  }
  if (hits.length === 0) return null;
  // Keep the trailing run (the folded field); drop earlier ones.
  const lastRunStart = hits.filter((h) => h >= sentences.length - hits.length);
  const drop = new Set(hits.filter((h) => !lastRunStart.includes(h)));
  if (drop.size === 0) return null;
  const kept = sentences.filter((_, i) => !drop.has(i)).join(" ").trim();
  return kept.length > 0 ? kept : null;
}

/** The longest prefix of `part` that `body` starts with, normalised. */
function leadingOverlap(body: string, part: string): number {
  const nb = normalize(body), np = normalize(part);
  if (!nb || !np) return 0;
  let lo = 0, hi = Math.min(nb.length, np.length);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (nb.startsWith(np.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Remove a leading duplicated span from `narration`, on a sentence boundary.
 *
 * Works on the raw text but measures on the normalised form, so punctuation
 * differences cannot leave a fragment behind. Returns null when no whole
 * sentence can be removed, which the caller treats as a rejection.
 */
function stripLeadingDuplicate(narration: string, part: string): string | null {
  const sentences = narration.split(/(?<=[.!?])\s+/);
  const np = normalize(part);
  let keepFrom = 0, consumed = "";
  for (let i = 0; i < sentences.length - 1; i++) {
    const next = normalize(`${consumed} ${sentences[i]}`).trim();
    if (!np.startsWith(next)) break;
    consumed = next;
    keepFrom = i + 1;
  }
  if (keepFrom === 0) return null;
  const rest = sentences.slice(keepFrom).join(" ").trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Validate — and where unambiguous, repair — a script's spoken structure.
 *
 * Mutates `script.segments[].narration` when it repairs, so the caller can
 * carry on with the corrected script.
 */
export function validateScriptStructure(script: ScriptLike): StructureResult {
  const issues: StructureIssue[] = [];
  const rejections: string[] = [];
  const segs = script.segments;
  if (!segs || segs.length === 0) {
    return { ok: false, issues, rejections: ["script has no segments"] };
  }
  const hook = (script.hook ?? "").trim();
  const cta = (script.cta ?? "").trim();

  const check = (
    seg: { narration: string }, part: string, label: "HOOK" | "CTA",
  ) => {
    if (!part) return;
    const nseg = normalize(seg.narration), npart = normalize(part);
    const exact = nseg.includes(npart);
    const lead = leadingOverlap(seg.narration, part);
    const near = tokenSimilarity(seg.narration.slice(0, LEAD_CHARS), part.slice(0, LEAD_CHARS));
    // `buildSpokenUnits` re-adds the part whenever the segment does not contain
    // it whole, so a partial overlap is exactly the case that gets spoken twice.
    if (!exact && lead < MIN_MEANINGFUL_OVERLAP && near < NEAR_DUPLICATE_SIMILARITY) return;

    const code = label === "HOOK" ? "HOOK_DUPLICATED" : "CTA_DUPLICATED";
    if (exact) {
      // Containing it ONCE is the designed state: folding is the single origin
      // of hook and CTA text, and nothing re-derives it. Containing it TWICE
      // means the model also wrote the line into the body, which the dedicated
      // field then duplicated — the field is canonical, so the body copy goes.
      const extra = countOccurrences(nseg, npart);
      if (extra < 2) return;
      const repairedText = stripEarlierOccurrence(seg.narration, part);
      if (repairedText) {
        seg.narration = repairedText;
        issues.push({
          code, detail: `${label} appeared ${extra} times; removed the body copy and kept the dedicated field`,
          repaired: true,
        });
        return;
      }
      rejections.push(`${label} appears ${extra} times in its segment and cannot be deduplicated safely`);
      issues.push({ code, detail: `${extra} occurrences, not repairable`, repaired: false });
      return;
    }
    const repaired = label === "HOOK" ? stripLeadingDuplicate(seg.narration, part) : null;
    if (repaired) {
      seg.narration = repaired;
      issues.push({
        code, detail: `removed a ${lead}-char leading ${label} prefix the unit builder would have re-read`,
        repaired: true,
      });
      return;
    }
    rejections.push(
      `${label} is partially duplicated in its segment (leading overlap ${lead} chars, ` +
      `similarity ${near.toFixed(2)}) and cannot be repaired deterministically`);
    issues.push({ code, detail: "partial duplication, not repairable", repaired: false });
  };

  check(segs[0]!, hook, "HOOK");
  // A sentence of the dedicated field written into the body as well: the field
  // is canonical, so the body copy is removed before anything is judged.
  const lastSeg = segs[segs.length - 1]!;
  const deduped = dedupeFieldSentences(lastSeg.narration, cta);
  if (deduped) {
    lastSeg.narration = deduped;
    issues.push({
      code: "CTA_DUPLICATED",
      detail: "removed a CTA line the model had also written into the body",
      repaired: true,
    });
  }
  check(lastSeg, cta, "CTA");

  // Any sentence spoken twice anywhere, measured on the assembled units —
  // which is the text ElevenLabs actually receives.
  const seen = new Map<string, number>();
  for (const u of buildSpokenUnits(script)) {
    for (const raw of u.text.split(/(?<=[.!?])\s+/)) {
      const n = normalize(raw);
      if (n.split(" ").length < 5) continue;   // fragments are not repetition
      seen.set(n, (seen.get(n) ?? 0) + 1);
    }
  }
  for (const [sentence, n] of seen) {
    if (n < 2) continue;
    rejections.push(`a sentence is spoken ${n} times: "${sentence.slice(0, 80)}…"`);
    issues.push({ code: "SENTENCE_REPEATED", detail: `${n} occurrences`, repaired: false });
  }

  return { ok: rejections.length === 0, issues, rejections };
}
