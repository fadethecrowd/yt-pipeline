import { MARINE_SUBJECTS } from "@yt-pipeline/pipeline-core";
import type { FragmentAllocation } from "./conceptAccounting";

/**
 * Local-monotony measurement for Wet Circuit. DIAGNOSTIC ONLY.
 *
 * Nothing here gates anything. It reports a number alongside the existing
 * `no-dominant-concept` check so the two can be compared on real candidates;
 * it has no threshold, no PASS/FAIL, and no effect on candidate status,
 * upload eligibility, narration budget or the pilot cap.
 *
 * WHY THIS EXISTS
 *
 * `no-dominant-concept` measures the share of the timeline one concept holds.
 * Three measured WC candidates showed that share tracks *thematic prevalence*
 * rather than *visual monotony* on a channel whose entire subject is boats and
 * water: the candidate with the highest concept-set change rate (100%), the
 * most concepts (5) and the highest entropy still failed, while the genuinely
 * repetitive candidate — 20 consecutive fragments of vessel footage — failed
 * for a number only 20 points worse.
 *
 * Windowed local concentration was tested and does not separate them either:
 * at 45s and 60s the repetitive candidate scores BETTER than a varied one,
 * because any minute of marine B-roll is dominated by water or vessel.
 *
 * What did separate them is whether the visual vocabulary goes stale — whether
 * anything NEW appears. That is what this measures.
 *
 * THE METRIC
 *
 * For every possible starting fragment:
 *   1. the run's allowed vocabulary is fixed to that fragment's concrete
 *      concept set;
 *   2. the run extends forward while each next fragment introduces no concrete
 *      concept outside that INITIAL set;
 *   3. the first fragment carrying a concept outside it ends the run, before
 *      that fragment.
 *
 * The allowed set is deliberately NOT widened as the run proceeds. A run is a
 * stretch during which the palette established at its start is never added to.
 * Widening it would measure "one broad concept stayed on screen", which is the
 * confound this metric exists to avoid: {vessel} → {vessel, water} ends a run,
 * because water is new relative to where the run began.
 *
 * Alternation INSIDE the established vocabulary does not end a run:
 *   {vessel,water} → {vessel} → {water} → {vessel,water}
 * is one uninterrupted run — nothing new was introduced.
 */

/** The concrete visual categories. Derived from the taxonomy, never restated. */
const CONCRETE = new Set(Object.keys(MARINE_SUBJECTS));

/**
 * A fragment's concrete concept set.
 *
 * Allocation keys that are not marine categories — "card", "generic-abstract",
 * "none", "unknown", "human-performance" — are excluded, so such a fragment
 * yields the EMPTY set. It therefore introduces no new concrete concept and
 * cannot end a run, while its seconds still count as elapsed screen time.
 * A card is an absence of new visual vocabulary, not a new one.
 */
export function concreteSetOf(f: FragmentAllocation): string[] {
  return Object.keys(f.allocation).filter((k) => CONCRETE.has(k)).sort();
}

/** Whether the fragment carries no concrete concept at all. */
function isNonConcrete(f: FragmentAllocation): boolean {
  return concreteSetOf(f).length === 0;
}

export interface NoNewConceptRun {
  /** Elapsed seconds of the longest run. */
  seconds: number;
  /** Those seconds as a fraction of the projected timeline. */
  shareOfTimeline: number;
  startS: number;
  endS: number;
  /** Indices into the supplied fragment sequence, inclusive. */
  startFragmentIndex: number;
  endFragmentIndex: number;
  fragmentCount: number;
  beatCount: number;
  /** The vocabulary fixed at the run's first fragment. */
  initialConcreteConcepts: string[];
  /** Every concrete concept actually seen inside the run — a subset of the above. */
  allConcreteConceptsSeen: string[];
  /** Seconds inside the run whose fragment was labelled a genuine no-match. */
  genuineNoneSeconds: number;
  /** Seconds inside the run on a card or other non-concrete label. */
  nonConcreteSeconds: number;
  uniqueAssetCount: number;
  assetIds: string[];
  /** Adjacent concept-set changes inside the run. */
  conceptSetChangeCount: number;
  conceptSetChangeRate: number;
}

/**
 * The longest stretch during which no new concrete concept is introduced.
 *
 * Consumes the SAME projected allocation the WC feasibility gate produced —
 * `tieAwareConceptAccounting(report).fragments`, in timeline order. It builds
 * no allocation of its own and runs no classifier, so it cannot describe a
 * different video from the one the gate judged.
 *
 * Ties are already resolved into their full concrete set by that accounting,
 * so "ambiguous" never appears here.
 *
 * Returns null for an empty sequence.
 */
export function longestNoNewConceptRun(
  fragments: FragmentAllocation[],
): NoNewConceptRun | null {
  if (fragments.length === 0) return null;

  // Fragments tile the projected timeline in order, so the clock is cumulative.
  const starts: number[] = [];
  let clock = 0;
  for (const f of fragments) { starts.push(clock); clock += f.projectedSeconds; }
  const timelineSeconds = clock;

  const sets = fragments.map(concreteSetOf);

  let best: { i: number; j: number; seconds: number } | null = null;
  for (let i = 0; i < fragments.length; i++) {
    // The vocabulary is fixed here and never widened.
    const allowed = new Set(sets[i]);
    let seconds = fragments[i].projectedSeconds;
    let j = i;
    for (let k = i + 1; k < fragments.length; k++) {
      if (sets[k].some((c) => !allowed.has(c))) break;
      seconds += fragments[k].projectedSeconds;
      j = k;
    }
    if (!best || seconds > best.seconds) best = { i, j, seconds };
  }
  if (!best) return null;

  const slice = fragments.slice(best.i, best.j + 1);
  const sliceSets = sets.slice(best.i, best.j + 1);

  let changes = 0;
  for (let k = 1; k < sliceSets.length; k++) {
    if (sliceSets[k].join("+") !== sliceSets[k - 1].join("+")) changes += 1;
  }

  const seen = new Set<string>();
  for (const s of sliceSets) for (const c of s) seen.add(c);

  const assetIds = [...new Set(slice.map((f) => f.assetId))];

  return {
    seconds: best.seconds,
    shareOfTimeline: timelineSeconds > 0 ? best.seconds / timelineSeconds : 0,
    startS: starts[best.i],
    endS: starts[best.j] + fragments[best.j].projectedSeconds,
    startFragmentIndex: best.i,
    endFragmentIndex: best.j,
    fragmentCount: slice.length,
    beatCount: new Set(slice.map((f) => f.beatIndex)).size,
    initialConcreteConcepts: [...sets[best.i]],
    allConcreteConceptsSeen: [...seen].sort(),
    genuineNoneSeconds: slice
      .filter((f) => f.outcome === "GENUINE_NONE")
      .reduce((a, f) => a + f.projectedSeconds, 0),
    nonConcreteSeconds: slice
      .filter((f) => f.outcome !== "GENUINE_NONE" && isNonConcrete(f))
      .reduce((a, f) => a + f.projectedSeconds, 0),
    uniqueAssetCount: assetIds.length,
    assetIds,
    conceptSetChangeCount: changes,
    conceptSetChangeRate: sliceSets.length > 1 ? changes / (sliceSets.length - 1) : 0,
  };
}

export interface WcLocalMonotonyDiagnostics {
  longestNoNewConceptRun: NoNewConceptRun | null;
}

/**
 * The diagnostic bundle recorded alongside feasibility evidence.
 *
 * Deliberately carries no verdict field. Adding one here would be the first
 * step toward gating on a number that three candidates cannot calibrate.
 */
export function wcLocalMonotonyDiagnostics(
  fragments: FragmentAllocation[],
): WcLocalMonotonyDiagnostics {
  return { longestNoNewConceptRun: longestNoNewConceptRun(fragments) };
}
