/**
 * Named quality profiles.
 *
 * The pipeline's defaults were tuned for premium automated output: a 40%
 * concept cap, near-zero tolerance for repeated shoots, aerials only as
 * establishing shots. Three candidates failed those gates not because the
 * footage was wrong but because a free stock library is broad and shallow —
 * it holds the subject and not the variety.
 *
 * Max's decision is to convert the remaining ElevenLabs credits into a finite
 * batch of watchable videos rather than produce none. That is a product
 * choice, so it lives here as a named profile with an explicit rationale,
 * rather than as quietly lowered constants that nobody can later account for.
 *
 * ONLY aesthetic tolerances move. Everything that protects a viewer from being
 * misled, or the project from spending money by accident, is identical in
 * every profile and is not expressible here at all.
 */

export type QualityProfileName =
  | "PREMIUM_AUTOMATED_VISUAL_QUALITY"
  | "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY";

export interface QualityProfile {
  name: QualityProfileName;
  /** Why this profile exists, carried into every report that uses it. */
  rationale: string;
  /** Largest share of the timeline one visual concept may occupy. */
  maxConceptShare: number;
  /** Selected fragments allowed from one obvious shoot or contributor. */
  maxPerShootCluster: number;
  /** Share of selected fragments that may be aerial or drone footage. */
  maxAerialShare: number;
  /** Share of beats that may fall back to an explanatory card. */
  maxCardShare: number;
  /** Whether broadly relevant B-roll may illustrate a conceptual claim. */
  allowConceptualBRoll: boolean;
}

export const PREMIUM_AUTOMATED_VISUAL_QUALITY: QualityProfile = {
  name: "PREMIUM_AUTOMATED_VISUAL_QUALITY",
  rationale:
    "Default. Assumes a footage library deep enough that visual variety is achievable without "
    + "compromise, and refuses output that would look repetitive.",
  maxConceptShare: 0.4,
  maxPerShootCluster: 2,
  maxAerialShare: 0.2,
  maxCardShare: 0.15,
  allowConceptualBRoll: false,
};

export const FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY: QualityProfile = {
  name: "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY",
  rationale:
    "Authorised by Max for a finite batch on the current Pexels-only library. Prefers visually "
    + "mediocre but coherent videos over producing none. Relaxes aesthetic diversity only: the "
    + "review question becomes 'would a reasonable viewer understand the narration, and are the "
    + "visuals relevant enough that the video is not confusing or embarrassing?' rather than "
    + "'is this visually premium?'. Honesty, brand-safety, reuse, looping and spend controls are "
    + "unchanged and are not part of any profile.",
  maxConceptShare: 0.6,
  maxPerShootCluster: 4,
  maxAerialShare: 0.5,
  maxCardShare: 0.25,
  allowConceptualBRoll: true,
};

const PROFILES: Record<QualityProfileName, QualityProfile> = {
  PREMIUM_AUTOMATED_VISUAL_QUALITY,
  FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY,
};

/**
 * Profiles are opt-in per asset. There is no environment switch and no global
 * default override: an asset produced under a relaxed profile should be
 * traceable to the decision that authorised it.
 */
export function qualityProfile(name: QualityProfileName): QualityProfile {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown quality profile: ${name}`);
  return p;
}

/**
 * Invariants no profile may express, stated so a future profile cannot quietly
 * acquire them. Asserted by tests.
 */
export const NON_NEGOTIABLE = [
  "no exact asset reuse",
  "no loops",
  "no frozen extensions",
  "no reverse or ping-pong playback",
  "no visibly unrelated footage",
  "no metadata-only match contradicted by the visible content",
  "no visible high-risk brands or proprietary interfaces",
  "no misleading implication that generic footage proves a specific factual claim",
  "no consecutive cards",
  "no silent ElevenLabs spending",
  "no upload without a durable upload intent",
  "no public upload during qualification",
] as const;
