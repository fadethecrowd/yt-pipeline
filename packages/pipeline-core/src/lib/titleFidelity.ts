import { normalize } from "./scriptStructure";

/**
 * A title may not assert what the script never established.
 *
 * Run e704334a turned "AI Credits Are Being Resold for Profit" into "Stolen AI
 * Credits Are Funding a Black Market — Here's the Proof". The script describes
 * brokers buying capacity in bulk and reselling it: a legal arbitrage business.
 * Nothing in it is stolen, nothing is a black market, and no proof is offered.
 * A wildcard candidate in the same round claimed first-person experience the
 * narrator never had.
 *
 * CTR optimisation is allowed to sharpen a claim. It is not allowed to invent
 * one. So each escalating term must be earned: the term, or a direct synonym,
 * has to appear in the evidence the script actually rests on.
 *
 * Deliberately a lexicon rather than a model call. The check has to be
 * deterministic and reviewable — and asking a model whether its own title was
 * justified is the failure mode this exists to catch.
 */

/** Escalations, each with the synonyms that would legitimately support it. */
const ESCALATIONS: { term: string; synonyms: string[] }[] = [
  { term: "stolen", synonyms: ["stolen", "steal", "theft", "stole"] },
  { term: "theft", synonyms: ["theft", "stolen", "steal"] },
  { term: "black market", synonyms: ["black market", "underground market", "illicit"] },
  { term: "proof", synonyms: ["proof", "proven", "evidence", "documented"] },
  { term: "leaked", synonyms: ["leaked", "leak"] },
  { term: "exposed", synonyms: ["exposed", "expose", "exposé"] },
  { term: "scam", synonyms: ["scam", "scammed"] },
  { term: "fraud", synonyms: ["fraud", "fraudulent"] },
  { term: "illegal", synonyms: ["illegal", "unlawful", "against the law"] },
  { term: "criminal", synonyms: ["criminal", "crime"] },
];

/** "$4", "$1.2b", "4 million dollars" — a figure the script must also carry. */
const DOLLAR = /\$\s?\d|(\d[\d,.]*)\s*(million|billion|trillion)?\s*dollars?/i;
/**
 * A first-person narrative claim: the pronoun "I" followed by a past-tense verb.
 *
 * The pronoun is matched case-sensitively — lowercase "i" is almost always part
 * of another word or a stylised title — while the verb is not, so "I Bought"
 * in title case is caught exactly like "I bought" in a sentence.
 *
 * "read" and "got" are deliberately absent: they are tense-ambiguous, and
 * "I read every comment" is CTA boilerplate on this channel rather than a
 * narrative claim. Counting it would let any script with a standard outro
 * license a title claiming first-hand experience the narrator never had.
 */
const PAST_VERBS = new Set([
  "ran", "saw", "found", "built", "bought", "tried", "spoke", "asked", "tested",
  "watched", "made", "went", "took", "paid", "spent", "lost",
]);
function hasFirstPersonClaim(text: string): boolean {
  for (const m of text.matchAll(/\bI\s+([A-Za-z]+)/g)) {
    const verb = m[1]!.toLowerCase();
    if (verb.endsWith("ed") || PAST_VERBS.has(verb)) return true;
  }
  return false;
}

export interface FidelityResult {
  ok: boolean;
  /** Escalating terms detected in the title. */
  triggered: string[];
  /** Those the evidence does not support. Empty means the title is earned. */
  unsupported: string[];
  reason: string;
}

/**
 * Does `evidence` — topic, script and any source context — support the claims
 * this title makes?
 */
export function checkTitleFidelity(title: string, evidence: string): FidelityResult {
  const nt = normalize(title);
  const ne = normalize(evidence);
  const triggered: string[] = [];
  const unsupported: string[] = [];

  for (const { term, synonyms } of ESCALATIONS) {
    if (!nt.includes(normalize(term))) continue;
    triggered.push(term);
    if (!synonyms.some((s) => ne.includes(normalize(s)))) unsupported.push(term);
  }
  if (DOLLAR.test(title)) {
    triggered.push("dollar figure");
    // The figure itself must appear, not merely some other number.
    const figures = title.match(/\$\s?[\d,.]+\s*(?:million|billion|trillion)?/gi) ?? [];
    const supported = figures.length > 0 && figures.every((f) => ne.includes(normalize(f)));
    if (!supported) unsupported.push("dollar figure");
  }
  if (hasFirstPersonClaim(title)) {
    triggered.push("first-person claim");
    if (!hasFirstPersonClaim(evidence)) unsupported.push("first-person claim");
  }

  return {
    ok: unsupported.length === 0,
    triggered,
    unsupported,
    reason: unsupported.length === 0
      ? triggered.length === 0
        ? "no escalating claim"
        : `every escalation is supported: ${triggered.join(", ")}`
      : `unsupported by the script: ${unsupported.join(", ")}`,
  };
}

/**
 * The highest-scoring candidate whose claims the script actually supports.
 *
 * Order is the caller's ranking; the first title that passes wins. When none
 * does, the baseline is returned — it is derived from the topic and therefore
 * asserts nothing the script does not.
 */
export function selectFaithfulTitle(
  ranked: string[],
  evidence: string,
  baseline: string,
): { title: string; disqualified: { title: string; reason: string }[]; usedBaseline: boolean } {
  const disqualified: { title: string; reason: string }[] = [];
  for (const title of ranked) {
    const r = checkTitleFidelity(title, evidence);
    if (r.ok) return { title, disqualified, usedBaseline: false };
    disqualified.push({ title, reason: r.reason });
  }
  return { title: baseline, disqualified, usedBaseline: true };
}
