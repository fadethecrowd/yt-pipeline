import {
  classifyConcept, MARINE_SUBJECTS,
  MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS,
  qualityProfile,
} from "@yt-pipeline/pipeline-core";
import type {
  FeasibilityReport, FeasibilityCheck, QualityProfileName,
} from "@yt-pipeline/pipeline-core";

/**
 * Tie-aware concept concentration for Wet Circuit.
 *
 * The shared gate labels a fragment "none" whenever the classifier's evidence
 * ties between concepts, because `scoreRelevance` collapses "ambiguous" into
 * "none". A captured replay of both failed WC candidates showed that ALL of
 * their "none" seconds — 275.4 s across the two — were ties, and every one was
 * unmistakably marine footage: "sailboat sailing in lake at dawn", "boat
 * sailing on the sea", "marina with boats seen from a boat". Reporting those
 * as an unnameable subject made the dominant-concept metric describe something
 * that was not true of the video.
 *
 * A tie is not an absence of meaning; it is two meanings at once. "A boat on
 * the water" genuinely is both vessel and water, and the honest accounting is
 * to divide the fragment's seconds between them rather than discard both.
 *
 * Bucketing every tie under one "ambiguous" label would be no better: it would
 * merge vessel+water with electronics+install into a single category that no
 * viewer perceives, and could manufacture a dominant concept out of unrelated
 * pairs.
 *
 * Rules:
 *   A. one winning concrete concept → all of the fragment's seconds to it
 *   B. N tied concrete concepts     → seconds / N to each
 *   C. no concept matched at all    → all seconds to "none"
 *   D. "ambiguous" is never itself a bucket
 *
 * Splitting divides; it never duplicates. The sum of allocated seconds equals
 * the projected timeline exactly, so the denominator is unchanged and the 40%
 * cap means what it always meant.
 *
 * Wet Circuit only. AI Doom's gate is untouched and keeps its existing
 * behaviour; nothing here is reachable from it.
 */

/**
 * Which concept-share tolerance this evaluation used.
 *
 * STRICT is the default and is the repository's long-standing
 * `MAX_CONCEPT_SHARE`, deliberately NOT the profile object's copy of the same
 * number: a later edit to the profile must not silently move Wet Circuit's
 * default.
 *
 * FINITE_CREDIT is opt-in per run and reads the tolerance the existing
 * FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY profile already owns. It relaxes ONE
 * aesthetic tolerance and nothing else — the profile's other fields
 * (card share, aerial share, shoot cluster, conceptual B-roll) are not read
 * here, and are not consumed anywhere in production, so selecting this profile
 * cannot quietly widen an unrelated quality control.
 */
export type ConceptShareMode = "STRICT" | "FINITE_CREDIT";

export interface ConceptShareTolerance {
  mode: ConceptShareMode;
  /** The profile whose decision this is, or null when strict/default. */
  profileName: QualityProfileName | null;
  maxConceptShare: number;
}

export interface TieAwareOptions {
  /**
   * Opt in to a named quality profile for the concept-share tolerance only.
   *
   * Absent means strict. An unrecognised name throws via `qualityProfile`,
   * so a typo refuses rather than silently falling back to relaxed behaviour.
   */
  qualityProfileName?: QualityProfileName;
}

/** Resolve the tolerance. Fails closed: unknown name throws, absence is strict. */
export function resolveConceptShareTolerance(
  opts: TieAwareOptions = {},
): ConceptShareTolerance {
  if (opts.qualityProfileName === undefined) {
    return { mode: "STRICT", profileName: null, maxConceptShare: MAX_CONCEPT_SHARE };
  }
  // Throws on an unknown identifier — the fail-closed path.
  const p = qualityProfile(opts.qualityProfileName);
  return {
    mode: p.name === "PREMIUM_AUTOMATED_VISUAL_QUALITY" ? "STRICT" : "FINITE_CREDIT",
    profileName: p.name,
    // The value belongs to the profile; it is never restated here.
    maxConceptShare: p.maxConceptShare,
  };
}

/** Labels that are not concrete visual categories a viewer would perceive. */
const NON_CONCRETE = new Set(["none", "ambiguous", "generic-abstract", "card", "unknown", "human-performance"]);

export type FragmentOutcome = "SINGLE" | "TIE" | "GENUINE_NONE" | "NON_CONCRETE";

export interface FragmentAllocation {
  beatIndex: number;
  assetId: string;
  description: string;
  projectedSeconds: number;
  /** What production labelled it. */
  conceptFinal: string;
  /** What the classifier itself answered, before any remapping. */
  conceptRaw: string;
  outcome: FragmentOutcome;
  /** Every concrete concept that tied, when `outcome` is TIE. */
  tiedConcepts: string[];
  /** Weighted evidence score that produced the decision. */
  score: number;
  /** Specificity (longest matched phrase, tokens) behind the decision. */
  longest: number;
  /** Seconds given to each concept by this fragment. Sums to projectedSeconds. */
  allocation: Record<string, number>;
}

export interface TieAwareAccounting {
  fragments: FragmentAllocation[];
  /** Seconds per concept after tie splitting, including "none". */
  conceptSeconds: Record<string, number>;
  /** Projected timeline seconds — the denominator. Unchanged by splitting. */
  denominatorSeconds: number;
  conceptShares: Record<string, number>;
  /** Seconds where no concept matched at all. */
  genuineNoneSeconds: number;
  genuineNoneShare: number;
  /** Concrete concepts holding non-zero duration. */
  distinctConcreteConcepts: number;
  concreteConcepts: string[];
  /** Largest CONCRETE concept. "none" is reported separately. */
  dominantConcept: string | null;
  dominantShare: number;
  /** Largest bucket of any kind, which is what the cap is applied to. */
  dominantAnyConcept: string | null;
  dominantAnyShare: number;
  /** Which tolerance this evaluation applied, and on whose authority. */
  tolerance: ConceptShareTolerance;
  /** The two concept checks, recomputed. Same names, same thresholds. */
  checks: FeasibilityCheck[];
  /** Would the gate pass on the concept checks alone? */
  concentrationOk: boolean;
}

/**
 * Recompute concept accounting from the report the real gate produced.
 *
 * The allocation, the assets and the seconds all come from
 * `report.predictedBeats` — the gate's own output — so this cannot describe a
 * different video. Only the LABELLING of already-allocated seconds changes.
 */
export function tieAwareConceptAccounting(
  report: FeasibilityReport,
  opts: TieAwareOptions = {},
): TieAwareAccounting {
  const tolerance = resolveConceptShareTolerance(opts);
  const fragments: FragmentAllocation[] = [];
  const conceptSeconds: Record<string, number> = {};
  const add = (concept: string, seconds: number) => {
    conceptSeconds[concept] = (conceptSeconds[concept] ?? 0) + seconds;
  };

  for (const beat of report.predictedBeats) {
    for (const f of beat.fragments) {
      const raw = classifyConcept(f.description, MARINE_SUBJECTS);
      const allocation: Record<string, number> = {};
      let outcome: FragmentOutcome;
      let tiedConcepts: string[] = [];

      // A production label that is neither a marine concept nor "none" —
      // "generic-abstract" and "card" — is left exactly as production filed
      // it. Re-deriving it from the slug would overrule a verdict the gate
      // reached for reasons a slug does not carry.
      if (f.concept !== "none" && NON_CONCRETE.has(f.concept)) {
        outcome = "NON_CONCRETE";
        allocation[f.concept] = f.durationS;
      } else if (raw.concept === "ambiguous" && (raw.tied?.length ?? 0) > 1) {
        // B. Split evenly among the concepts that actually tied.
        outcome = "TIE";
        tiedConcepts = [...raw.tied!];
        const each = f.durationS / tiedConcepts.length;
        for (const c of tiedConcepts) allocation[c] = (allocation[c] ?? 0) + each;
      } else if (raw.concept === "none") {
        // C. Nothing matched — this is a real absence of recognised subject.
        outcome = "GENUINE_NONE";
        allocation.none = f.durationS;
      } else {
        // A. One winning concrete concept.
        outcome = "SINGLE";
        allocation[raw.concept] = f.durationS;
      }

      for (const [c, s] of Object.entries(allocation)) add(c, s);
      fragments.push({
        beatIndex: beat.index,
        assetId: f.assetId,
        description: f.description,
        projectedSeconds: f.durationS,
        conceptFinal: f.concept,
        conceptRaw: raw.concept,
        outcome,
        tiedConcepts,
        score: raw.score,
        longest: raw.longest ?? 0,
        allocation,
      });
    }
  }

  const denominatorSeconds = Object.values(conceptSeconds).reduce((a, s) => a + s, 0);
  const conceptShares: Record<string, number> = {};
  for (const [c, s] of Object.entries(conceptSeconds)) {
    conceptShares[c] = denominatorSeconds > 0 ? s / denominatorSeconds : 0;
  }

  const genuineNoneSeconds = conceptSeconds.none ?? 0;
  const genuineNoneShare = denominatorSeconds > 0 ? genuineNoneSeconds / denominatorSeconds : 0;

  const concreteEntries = Object.entries(conceptSeconds)
    .filter(([c, s]) => !NON_CONCRETE.has(c) && s > 0)
    .sort((a, b) => b[1] - a[1]);
  const concreteConcepts = concreteEntries.map(([c]) => c);

  const dominantConcept = concreteEntries[0]?.[0] ?? null;
  const dominantShare = concreteEntries[0] && denominatorSeconds > 0
    ? concreteEntries[0][1] / denominatorSeconds : 0;

  // The cap applies to the largest bucket of ANY kind: a timeline that is
  // mostly unrecognisable footage must still fail, exactly as before.
  const anyEntries = Object.entries(conceptSeconds).sort((a, b) => b[1] - a[1]);
  const dominantAnyConcept = anyEntries[0]?.[0] ?? null;
  const dominantAnyShare = anyEntries[0] && denominatorSeconds > 0
    ? anyEntries[0][1] / denominatorSeconds : 0;

  const checks: FeasibilityCheck[] = [
    {
      name: "concept-diversity",
      ok: concreteConcepts.length >= MIN_DISTINCT_CONCEPTS,
      detail:
        `${concreteConcepts.length} distinct concrete visual category/ies ` +
        `(need ${MIN_DISTINCT_CONCEPTS}): ${concreteConcepts.join(", ") || "none"}`,
    },
    {
      name: "no-dominant-concept",
      ok: dominantAnyShare <= tolerance.maxConceptShare,
      detail: dominantAnyConcept
        ? `largest concept "${dominantAnyConcept}" holds ` +
          `${(dominantAnyShare * 100).toFixed(1)}% of projected timeline; ` +
          `cap ${(tolerance.maxConceptShare * 100).toFixed(0)}% ` +
          `[${tolerance.mode}${tolerance.profileName ? ` ${tolerance.profileName}` : ""}] ` +
          `(tie-aware accounting)`
        : "no concepts projected",
    },
  ];

  return {
    fragments,
    conceptSeconds,
    denominatorSeconds,
    conceptShares,
    genuineNoneSeconds,
    genuineNoneShare,
    distinctConcreteConcepts: concreteConcepts.length,
    concreteConcepts,
    dominantConcept,
    dominantShare,
    dominantAnyConcept,
    dominantAnyShare,
    tolerance,
    checks,
    concentrationOk: checks.every((c) => c.ok),
  };
}

/**
 * The gate's checks with the two concept checks replaced by their tie-aware
 * equivalents. Every other check is the gate's own, untouched.
 */
export function tieAwareChecks(
  report: FeasibilityReport,
  accounting: TieAwareAccounting,
): FeasibilityCheck[] {
  const replaced = new Map(accounting.checks.map((c) => [c.name, c]));
  return report.checks.map((c) => replaced.get(c.name) ?? c);
}
