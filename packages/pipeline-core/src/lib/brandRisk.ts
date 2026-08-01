/**
 * Conservative normalisation of a vision judge's brandRisk field.
 *
 * The first benchmark run lost 7 of 56 judgments to a single validator
 * rejection — `brandRisk invalid` — because the field accepted only the exact
 * strings NONE, POSSIBLE and VISIBLE. Three otherwise-usable DIRECT judgments
 * were discarded by that strictness.
 *
 * The rule here is deliberately asymmetric. Recognised spellings map to their
 * value; anything unrecognised maps to POSSIBLE, never NONE. An unparseable
 * answer means we do not know whether a brand is on screen, and "we do not
 * know" must never be recorded as "there is none" — that is the direction that
 * lets branded footage through a gate.
 */

export type BrandRisk = "NONE" | "POSSIBLE" | "VISIBLE";

/**
 * Documented aliases only. Each maps a phrasing a model plausibly returns onto
 * one of the three levels. Anything outside this table is POSSIBLE by default,
 * so the table can stay small without weakening the outcome.
 */
const ALIASES: Record<string, BrandRisk> = {
  // NONE
  none: "NONE", no: "NONE", never: "NONE", absent: "NONE",
  "no brand": "NONE", "no brands": "NONE", "no branding": "NONE",
  "no visible brand": "NONE", "no visible branding": "NONE",
  "no brand risk": "NONE", "not present": "NONE", clean: "NONE",
  // POSSIBLE
  possible: "POSSIBLE", maybe: "POSSIBLE", low: "POSSIBLE", medium: "POSSIBLE",
  moderate: "POSSIBLE", partial: "POSSIBLE", unclear: "POSSIBLE",
  uncertain: "POSSIBLE", ambiguous: "POSSIBLE", indeterminate: "POSSIBLE",
  "possibly visible": "POSSIBLE", "minor branding": "POSSIBLE",
  "low risk": "POSSIBLE", "some branding": "POSSIBLE",
  // VISIBLE
  visible: "VISIBLE", yes: "VISIBLE", high: "VISIBLE", present: "VISIBLE",
  detected: "VISIBLE", "clearly visible": "VISIBLE", "brand visible": "VISIBLE",
  "visible branding": "VISIBLE", "high risk": "VISIBLE", "logo visible": "VISIBLE",
};

export interface BrandRiskNormalisation {
  value: BrandRisk;
  /** True when the input was recognised rather than defaulted. */
  recognised: boolean;
  /** Exactly what the model sent, kept for audit. */
  raw: unknown;
}

/**
 * Normalise whatever the model returned. Never throws: an unusable value is a
 * reason to be cautious, not a reason to discard the whole judgment.
 */
export function normaliseBrandRisk(raw: unknown): BrandRiskNormalisation {
  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const hit = ALIASES[key];
    if (hit) return { value: hit, recognised: true, raw };
  }
  // Objects, numbers, arrays, nulls and unknown wording all land here.
  return { value: "POSSIBLE", recognised: false, raw };
}
