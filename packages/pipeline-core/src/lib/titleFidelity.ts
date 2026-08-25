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

interface Escalation {
  /** Canonical label reported in `triggered` / `unsupported`. */
  term: string;
  /** Surface forms in a TITLE that assert this claim. */
  triggers: string[];
  /** Forms in the EVIDENCE that would legitimately support it. */
  synonyms: string[];
}

/**
 * Escalations, each with the title forms that fire it and the evidence forms
 * that earn it.
 *
 * `triggers` used to be a single word matched as a bare substring, and both
 * halves of that were wrong.
 *
 * Too narrow: only the exact listed inflection fired. "stole" appeared solely
 * in the synonyms — the evidence side — so the title "Copilot 'Fixed' the
 * Code. Then AI Stole Snowflake's Jira Keys." asserted theft and was never
 * checked for it, passing against a script containing no stole, stolen or
 * theft. The same hole existed for leak/leaks, expose/exposes, prove/proves and
 * crime, and "defraud" was invisible to the "fraud" entry because a bare
 * substring cannot see a word it does not start.
 *
 * Too wide: an unanchored substring lets any word ENDING in a trigger vouch for
 * it. Adding "prove" to the evidence side of `proof` under the old matcher
 * would have let a script that says "improve" license a title that claims
 * proof.
 *
 * `containsForm` resolves both: a match must begin at a word boundary, and any
 * suffix is allowed. "steal" therefore covers steals/stealing, "leak" covers
 * leaked/leaking, and "prove" covers proven/proves/proved while "improve"
 * matches nothing.
 */
const ESCALATIONS: Escalation[] = [
  { term: "stolen", triggers: ["stolen", "stole", "steal"],
    synonyms: ["stolen", "stole", "steal", "theft"] },
  { term: "theft", triggers: ["theft"],
    synonyms: ["theft", "stolen", "stole", "steal"] },
  { term: "black market", triggers: ["black market"],
    synonyms: ["black market", "underground market", "illicit"] },
  { term: "proof", triggers: ["proof", "prove"],
    synonyms: ["proof", "prove", "evidence", "documented"] },
  { term: "leaked", triggers: ["leak"], synonyms: ["leak"] },
  { term: "exposed", triggers: ["expose"], synonyms: ["expose"] },
  { term: "scam", triggers: ["scam"], synonyms: ["scam"] },
  { term: "fraud", triggers: ["fraud", "defraud"], synonyms: ["fraud", "defraud"] },
  { term: "illegal", triggers: ["illegal"], synonyms: ["illegal", "unlawful", "against the law"] },
  { term: "criminal", triggers: ["criminal", "crime"], synonyms: ["criminal", "crime"] },
];

/**
 * Does `haystack` contain `form` starting at a word boundary?
 *
 * Both arguments are already `normalize`d to lowercase letters, digits and
 * single spaces, so the form needs no regex escaping. A trailing boundary is
 * deliberately NOT required — inflections are the point.
 */
const FORM_MATCHERS = new Map<string, RegExp>();
function containsForm(haystack: string, form: string): boolean {
  const key = normalize(form);
  let re = FORM_MATCHERS.get(key);
  if (!re) {
    re = new RegExp(`\\b${key}`, "u");
    FORM_MATCHERS.set(key, re);
  }
  return re.test(haystack);
}

/** "$4", "$1.2b", "4 million dollars" — a figure the script must also carry. */
const DOLLAR = /\$\s?\d|(\d[\d,.]*)\s*(million|billion|trillion)?\s*dollars?/i;

/**
 * A quantity of TIME or COUNT, which the script must also carry.
 *
 * Run c28dd19c produced the wildcard title "The 18-Month Window to Stop AI
 * Hackers Forever Is Already Closing" for a script containing neither "18" nor
 * "month". It passed, because the only numeric rule here was about money. An
 * invented duration is exactly as false as an invented price — it just costs
 * nothing to say — so it is checked the same way.
 *
 * A bare unit is NOT matched: "for the first time in decades" asserts no
 * specific quantity and is ordinary prose. What is matched is a NUMBER bound to
 * a unit, digits or words, and the open-ended magnitude phrases.
 */
const NUMBER_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
  + "fifteen|eighteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|thousand";
const TIME_UNIT = "second|minute|hour|day|week|month|year|decade";
const QUANTITY = new RegExp(
  `(\\b(?:\\d[\\d,.]*|${NUMBER_WORD})[-\\s]?(?:${TIME_UNIT})s?\\b)`
  + `|(\\b(?:hundreds|thousands|millions|billions)\\s+of\\b)`
  + `|(\\b\\d[\\d,.]*\\s?%)`
  + `|(\\b\\d[\\d,.]*\\s?(?:percent|x)\\b)`,
  "gi",
);
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

  for (const { term, triggers, synonyms } of ESCALATIONS) {
    if (!triggers.some((t) => containsForm(nt, t))) continue;
    triggered.push(term);
    if (!synonyms.some((s) => containsForm(ne, s))) unsupported.push(term);
  }
  if (DOLLAR.test(title)) {
    triggered.push("dollar figure");
    // The figure itself must appear, not merely some other number.
    const figures = title.match(/\$\s?[\d,.]+\s*(?:million|billion|trillion)?/gi) ?? [];
    const supported = figures.length > 0 && figures.every((f) => ne.includes(normalize(f)));
    if (!supported) unsupported.push("dollar figure");
  }
  // Durations and counts, on the same terms as money.
  const quantities = [...new Set((title.match(QUANTITY) ?? []).map((q) => q.trim()))];
  for (const q of quantities) {
    const label = `quantity "${q}"`;
    triggered.push(label);
    // Normalised, so "18-Month" in a title is satisfied by "18 months" in the
    // script: punctuation is stripped and a trailing plural still contains the
    // singular form as a prefix.
    if (!ne.includes(normalize(q))) unsupported.push(label);
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
