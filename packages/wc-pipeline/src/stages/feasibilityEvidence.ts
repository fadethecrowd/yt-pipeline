import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assessVisualFeasibility, pexelsOnlySource,
  classifyConcept, MARINE_SUBJECTS,
  MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS, TITLE_CARD_S, runtimeRange,
} from "@yt-pipeline/pipeline-core";
import type {
  FeasibilityInput, FeasibilityReport, FeasibilityDeps, Candidate, FeasibilityCheck,
} from "@yt-pipeline/pipeline-core";
import { tieAwareConceptAccounting, tieAwareChecks } from "./conceptAccounting";
import type { TieAwareAccounting, FragmentOutcome } from "./conceptAccounting";

/**
 * Opt-in diagnostic evidence for Wet Circuit visual feasibility.
 *
 * The feasibility gate discards everything it learns. It reports that "none"
 * held 41% of a timeline without recording which assets those were, what
 * query found them, or what text the classifier actually saw — so a failure
 * cannot be diagnosed after the fact, only re-run.
 *
 * This captures that evidence WITHOUT re-deriving it. The real
 * `assessVisualFeasibility` runs unchanged and its returned report supplies
 * every allocation and every aggregate; the only thing added here is
 * provenance the report does not carry:
 *
 *   • which search query returned each asset — recorded by wrapping
 *     `deps.search`, which is a caller-supplied function, so no shared code
 *     changes to obtain it;
 *   • the pre-remap classification — recomputed with the same exported
 *     `classifyConcept` and the same `MARINE_SUBJECTS` the gate used, purely
 *     to distinguish a no-term-match from an `ambiguous` tie that
 *     `scoreRelevance` collapses into "none".
 *
 * Nothing here re-implements allocation or scoring, so the evidence cannot
 * describe a different video from the one the gate judged.
 *
 * Off by default: with no `outPath`, nothing is written and the returned
 * report is exactly what the gate produced.
 */

const CHANNEL = "wet-circuit" as const;

/** Why a fragment carries the label "none". */
export type NoneReason =
  | "NO_TERM_MATCH"
  | "AMBIGUOUS_REMAPPED_TO_NONE"
  | "GENERIC_VERDICT"
  | "NOT_NONE";

export interface EvidenceFragment {
  beatIndex: number;
  segmentIndex: number;
  beatDurationS: number;
  beatNarration: string;
  assetId: string;
  provider: string | null;
  pageUrl: string | null;
  /** The slug actually passed to classification. */
  description: string;
  /** Every query that returned this asset, in retrieval order. */
  queries: string[];
  /** The query that first surfaced it — the one that put it in the pool. */
  firstQuery: string | null;
  projectedSeconds: number;
  relevanceScore: number;
  verdict: string;
  /** classifyConcept's own answer, before scoreRelevance remaps anything. */
  conceptRaw: string;
  /** The label production used. */
  conceptFinal: string;
  noneReason: NoneReason;
  brandRisk: boolean;
  /** Projected allocation, or relevant-pool-only. */
  inProjectedAllocation: true;

  // ── Tie-aware accounting ───────────────────────────────────────────
  /** SINGLE, TIE, GENUINE_NONE or NON_CONCRETE. */
  outcome: FragmentOutcome;
  /** True when two or more concrete concepts tied. */
  tie: boolean;
  /** Every concrete concept that tied. Empty unless `tie`. */
  tiedConcepts: string[];
  /** Weighted evidence score behind the decision. */
  score: number;
  /** Specificity (longest matched phrase, in tokens) behind the decision. */
  longest: number;
  /** Seconds this fragment gives each concept. Sums to projectedSeconds. */
  allocation: Record<string, number>;
}

export interface WcFeasibilityEvidence {
  kind: "wc-visual-feasibility-evidence";
  version: 1;
  note: string;
  capturedAt: string;
  videoId: string;
  topic: string;
  scriptSha256: string;
  channel: typeof CHANNEL;

  targetRuntimeS: number;
  titleCardS: number;
  plannedVisualDurationS: number;
  runtimeEnvelope: { minS: number; maxS: number };
  maxConceptShare: number;
  minDistinctConcepts: number;

  searchQueries: string[];
  /** Assets returned per query, before de-duplication by assetId. */
  queryResults: { query: string; assetIds: string[] }[];
  poolSize: number;
  relevantPoolSize: number;

  beats: {
    index: number;
    segmentIndex: number;
    startS: number;
    endS: number;
    durationS: number;
    narration: string;
    cardSecondsS: number;
    hasCard: boolean;
    fragments: EvidenceFragment[];
  }[];

  /** Seconds per concept AFTER tie splitting. Includes genuine "none". */
  conceptSeconds: Record<string, number>;
  denominatorSeconds: number;
  conceptShares: Record<string, number>;
  /** Seconds where no concept matched at all — a real absence, not a tie. */
  genuineNoneSeconds: number;
  genuineNoneShare: number;
  distinctConcreteConcepts: number;
  concreteConcepts: string[];
  /** Largest CONCRETE concept. */
  dominantConcept: string | null;
  dominantShare: number;
  /** Largest bucket of any kind — what the cap is applied to. */
  dominantAnyConcept: string | null;
  dominantAnyShare: number;

  /** The gate's own checks, with the two concept checks recomputed. */
  checks: { name: string; ok: boolean; detail: string }[];
  /** The shared gate's untouched checks, for comparison. */
  sharedChecks: { name: string; ok: boolean; detail: string }[];
  /** The shared gate's own concept breakdown, before tie-aware accounting. */
  sharedConceptBreakdown: { concept: string; assets: number; projectedSeconds: number; share: number }[];
  pass: boolean;
  /** The shared gate's verdict, before tie-aware accounting. */
  sharedPass: boolean;
  failureReason: string | null;
}

export class WcEvidenceWriteError extends Error {
  constructor(readonly path: string, cause: string) {
    super(`could not write feasibility evidence to ${path}: ${cause}`);
    this.name = "WcEvidenceWriteError";
  }
}

/**
 * A `search` that records which query returned which assets.
 *
 * `FeasibilityDeps.search` is supplied by the caller, so recording it needs no
 * change to the gate. De-duplication still happens inside the gate exactly as
 * before; this only observes what went in.
 */
function recordingSource(
  inner: FeasibilityDeps,
  sink: { query: string; assetIds: string[] }[],
  byAsset: Map<string, { candidate: Candidate; queries: string[] }>,
): FeasibilityDeps {
  return {
    search: async (query: string) => {
      const results = await inner.search(query);
      sink.push({ query, assetIds: results.map((c) => c.assetId) });
      for (const c of results) {
        const e = byAsset.get(c.assetId);
        if (e) { if (!e.queries.includes(query)) e.queries.push(query); }
        else byAsset.set(c.assetId, { candidate: c, queries: [query] });
      }
      return results;
    },
  };
}

/** Why this fragment ended up labelled "none". Uses the gate's own taxonomy. */
function explainNone(description: string, conceptFinal: string, verdict: string): {
  conceptRaw: string;
  noneReason: NoneReason;
} {
  const raw = classifyConcept(description, MARINE_SUBJECTS);
  if (conceptFinal !== "none") {
    return { conceptRaw: raw.concept, noneReason: "NOT_NONE" };
  }
  if (verdict === "GENERIC") return { conceptRaw: raw.concept, noneReason: "GENERIC_VERDICT" };
  if (raw.concept === "ambiguous") {
    return { conceptRaw: "ambiguous", noneReason: "AMBIGUOUS_REMAPPED_TO_NONE" };
  }
  return { conceptRaw: raw.concept, noneReason: "NO_TERM_MATCH" };
}

/** Write JSON atomically: full file into place, or nothing. */
function writeAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.evidence.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    throw new WcEvidenceWriteError(path, err instanceof Error ? err.message : String(err));
  }
}

export interface CollectEvidenceOptions {
  videoId: string;
  scriptSha256: string;
  input: FeasibilityInput;
  pexelsApiKey: string;
  /**
   * Where to write the evidence JSON. **Omitted means no file is written and
   * no filesystem side effect occurs** — the gate runs exactly as in
   * production and only its report is returned.
   */
  outPath?: string;
}

/**
 * Run the real feasibility gate and, optionally, preserve what it saw.
 *
 * The returned report is the gate's own, untouched. Evidence is returned
 * alongside it, and written only when `outPath` is supplied.
 */
export async function collectWcFeasibilityEvidence(
  opts: CollectEvidenceOptions,
): Promise<{ report: FeasibilityReport; evidence: WcFeasibilityEvidence }> {
  const queryResults: { query: string; assetIds: string[] }[] = [];
  const byAsset = new Map<string, { candidate: Candidate; queries: string[] }>();

  const deps = recordingSource(pexelsOnlySource(opts.pexelsApiKey), queryResults, byAsset);

  // The real gate. Unchanged behaviour, unchanged arithmetic.
  const report = await assessVisualFeasibility(opts.input, deps);

  const accounting: TieAwareAccounting = tieAwareConceptAccounting(report);
  const allocByFragment = new Map<string, TieAwareAccounting["fragments"][number]>();
  for (const fa of accounting.fragments) allocByFragment.set(`${fa.beatIndex}:${fa.assetId}`, fa);

  const beats = report.predictedBeats.map((b) => ({
    index: b.index,
    segmentIndex: b.segmentIndex,
    startS: b.startS,
    endS: b.endS,
    durationS: b.durationS,
    narration: b.narration,
    cardSecondsS: b.cardSecondsS,
    hasCard: b.hasCard,
    fragments: b.fragments.map((f): EvidenceFragment => {
      const seen = byAsset.get(f.assetId);
      const { conceptRaw, noneReason } = explainNone(f.description, f.concept, f.verdict);
      const fa = allocByFragment.get(`${b.index}:${f.assetId}`);
      return {
        beatIndex: b.index,
        segmentIndex: b.segmentIndex,
        beatDurationS: b.durationS,
        beatNarration: b.narration,
        assetId: f.assetId,
        provider: seen?.candidate.provider ?? null,
        pageUrl: seen?.candidate.pageUrl ?? null,
        description: f.description,
        queries: seen?.queries ?? [],
        firstQuery: seen?.queries[0] ?? null,
        projectedSeconds: f.durationS,
        relevanceScore: f.relevanceScore,
        verdict: f.verdict,
        conceptRaw,
        conceptFinal: f.concept,
        noneReason,
        brandRisk: f.brandRisk,
        inProjectedAllocation: true,
        outcome: fa?.outcome ?? "GENUINE_NONE",
        tie: (fa?.tiedConcepts.length ?? 0) > 1,
        tiedConcepts: fa?.tiedConcepts ?? [],
        score: fa?.score ?? 0,
        longest: fa?.longest ?? 0,
        allocation: fa?.allocation ?? {},
      };
    }),
  }));

  const checks: FeasibilityCheck[] = tieAwareChecks(report, accounting);
  const failed = checks.filter((c) => !c.ok);
  const range = runtimeRange(CHANNEL, "LONGFORM", "PRODUCTION");

  const evidence: WcFeasibilityEvidence = {
    kind: "wc-visual-feasibility-evidence",
    version: 1,
    note:
      "Diagnostic replay. Pexels search results vary over time, so these assets " +
      "are NOT proof of what was returned during the original preparation attempt.",
    capturedAt: new Date().toISOString(),
    videoId: opts.videoId,
    topic: opts.input.topicTitle,
    scriptSha256: opts.scriptSha256,
    channel: CHANNEL,

    targetRuntimeS: opts.input.targetRuntimeS,
    titleCardS: TITLE_CARD_S,
    plannedVisualDurationS: report.plannedVisualDurationS,
    runtimeEnvelope: { minS: range.minS, maxS: range.maxS },
    maxConceptShare: MAX_CONCEPT_SHARE,
    minDistinctConcepts: MIN_DISTINCT_CONCEPTS,

    searchQueries: report.searchQueries,
    queryResults,
    poolSize: report.totalCandidates,
    relevantPoolSize: report.relevantCandidates,

    beats,

    conceptSeconds: accounting.conceptSeconds,
    denominatorSeconds: accounting.denominatorSeconds,
    conceptShares: accounting.conceptShares,
    genuineNoneSeconds: accounting.genuineNoneSeconds,
    genuineNoneShare: accounting.genuineNoneShare,
    distinctConcreteConcepts: accounting.distinctConcreteConcepts,
    concreteConcepts: accounting.concreteConcepts,
    dominantConcept: accounting.dominantConcept,
    dominantShare: accounting.dominantShare,
    dominantAnyConcept: accounting.dominantAnyConcept,
    dominantAnyShare: accounting.dominantAnyShare,

    checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    sharedChecks: report.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    sharedConceptBreakdown: report.conceptBreakdown,
    pass: failed.length === 0,
    sharedPass: report.pass,
    failureReason: failed.length === 0 ? null : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
  };

  if (opts.outPath) writeAtomic(opts.outPath, evidence);

  return { report, evidence };
}
