/**
 * Pre-TTS visual-source feasibility gate.
 *
 * AI Doom qualification asset #1 ("the AI chip shortage moved from GPUs to
 * memory") was a complete, correct pipeline run that produced an unusable
 * video. Its script was good, its narration was good, its captions were good,
 * its relevance scoring rejected exactly the footage it should have rejected,
 * and its beat pacing put a unique, on-topic, un-looped clip on every beat it
 * could fill. It still failed, because Pexels does not carry enough distinct
 * HBM / wafer / packaging / semiconductor-production footage to cover seven
 * minutes: 15 of 39 beats (38.5%) fell back to branded cards.
 *
 * The expensive part of that lesson is WHEN it was learned. The pipeline
 * discovered the topic was unillustratable only after 7,071 ElevenLabs credits
 * had been spent, because visual retrieval happens during assembly, which
 * happens after narration.
 *
 * This module moves the question earlier. Given a topic and a preliminary
 * narrative outline — before a single character is sent to ElevenLabs — it
 * builds the search queries assembly would build, searches the sources
 * assembly would search, applies the same acceptance rules assembly applies,
 * simulates the beat timeline assembly would produce, and answers one
 * question: can this topic be illustrated to standard?
 *
 * When the answer is no, the gate fails CLOSED and no narration is purchased.
 *
 * The simulation deliberately mirrors `renderBeat` in assemblyShared.ts rather
 * than approximating it. A gate that predicts something other than what
 * assembly does would be worse than no gate at all — it would either block
 * good topics or pass topics that still fail late.
 */
import {
  scoreRelevance, VisualPlan, buildSearchQueries, REJECT_THRESHOLD,
} from "./visualRelevance";
import type { RelevanceResult } from "./visualRelevance";
import { checkBrandFromMetadata, brandAdmits, isHighBrandRiskFootage } from "./brandGuard";
import { searchPexelsCandidates, validateCandidateMeta, AssetLedger } from "./visuals";
import type { Candidate } from "./visuals";
import {
  BEAT_TARGET_S, BEAT_MIN_S, BEAT_MAX_S, MIN_FRAGMENT_S, fitFragment,
} from "./visualBeats";
import { TITLE_CARD_S } from "./runtimeTargets";
import type { ChannelKey } from "./runtimeTargets";

// ── Feasibility thresholds ────────────────────────────────────────────────
//
// Every number here is a quality floor, not a tuning knob. Lowering one to get
// a topic through is the exact move that produced the HBM asset.

/** Predicted fallback-card share of the timeline, by beat count. */
export const MAX_CARD_SHARE = 0.15;

/**
 * The accepted pool must be this much larger than the bare minimum number of
 * unique assets the timeline needs. Assembly loses candidates to download
 * failures, decode errors, black-frame and frozen-frame checks that this gate
 * cannot run without downloading every clip, so a pool that exactly meets the
 * minimum will not survive contact with assembly.
 */
export const POOL_SAFETY_FACTOR = 1.25;

/** Usable source seconds must exceed planned visual seconds by this factor. */
export const DURATION_SAFETY_FACTOR = 1.25;

/** No single concept may occupy more than this share of projected timeline. */
export const MAX_CONCEPT_SHARE = 0.4;

/**
 * Per-channel feasibility policy.
 *
 * Stated as a table rather than inferred from an absent variable or a
 * neutralised threshold: reading `enforceDominantConceptCap: false` should tell
 * you the cap is off, not leave you deducing it from a 100% limit or a missing
 * env var. Both channels are listed explicitly so adding a third forces a
 * decision instead of inheriting one.
 */
export interface FeasibilityPolicy {
  /** Whether `no-dominant-concept` may FAIL a candidate on this channel. */
  enforceDominantConceptCap: boolean;
}

/**
 * AI Doom retired the dominant-concept cap on 2026-08-13, after human
 * timeline-level calibration showed it had never once been right.
 *
 * Seven real AI Doom timelines were labelled taxonomy-blind and weighted by
 * real on-screen seconds (tests/fixtures/concentration-timelines.json). Human
 * dominant share ran 14.0%-36.6%; NOTHING reached 40%. The automated measure
 * fired on five of the seven, and every firing was a false positive — it
 * overstated concentration by +23.6pp on average, always in the same
 * direction. Four supervised qualification attempts were blocked by it, and
 * the human labels say all four were varied videos carrying 8-18 distinct
 * kinds of shot. The one genuinely rejected asset, HBM, sits at 20.4% and was
 * caught by its real defects: 24% fallback cards and an insufficient source
 * library. The cap has no demonstrated true positive on this channel.
 *
 * Five measurement architectures were tried and none produced a trustworthy
 * number: the AI_SUBJECTS taxonomy, BGE single-link, BGE complete-link,
 * taxonomy/BGE hybrids, and prompt-intent grouping. The failure is structural
 * rather than a tuning problem — every one either over-merges and fails good
 * videos or over-splits and cannot see real monotony, with no threshold in
 * between. The research harnesses and frozen fixtures are kept precisely so
 * this is re-checkable rather than remembered.
 *
 * Visual variety on AI Doom is still protected, by the controls that actually
 * caught the real defects: fallback-card-share, no-consecutive-cards,
 * unique-assets-cover-timeline, pool-safety-margin, usable-duration-margin,
 * brand-risk-not-load-bearing, the concept-diversity floor, and the no-reuse
 * ledger. Only the dominant-share cap is retired.
 *
 * Wet Circuit keeps it, deliberately. Its taxonomy is closed and
 * domain-complete — five concepts that between them name essentially every
 * legitimate marine visual — so there the measure means what it says, and it
 * additionally has its own enforcement in wc-pipeline's conceptAccounting.
 */
export const FEASIBILITY_POLICY: Record<ChannelKey, FeasibilityPolicy> = {
  "ai-doom-scroll": { enforceDominantConceptCap: false },
  "wet-circuit": { enforceDominantConceptCap: true },
};

export function feasibilityPolicyFor(channel: ChannelKey): FeasibilityPolicy {
  const p = FEASIBILITY_POLICY[channel];
  // Fail closed: an unknown channel enforces every control.
  return p ?? { enforceDominantConceptCap: true };
}

/** A topic needs at least this many distinct, concrete visual categories. */
export const MIN_DISTINCT_CONCEPTS = 3;

// ── Inputs ────────────────────────────────────────────────────────────────

/**
 * A preliminary narrative unit. This is deliberately the shape a script
 * segment already has, so the gate can run against either a real script or a
 * pre-script outline without a conversion step.
 */
export interface OutlineSegment {
  segmentIndex: number;
  title: string;
  narration: string;
  visual_prompt: string;
}

export interface FeasibilityInput {
  channel: ChannelKey;
  topicTitle: string;
  /** Target total video runtime in seconds, including the title card. */
  targetRuntimeS: number;
  segments: OutlineSegment[];
}

/** Injectable so tests never touch the network. */
export interface FeasibilityDeps {
  /** Search one query against the configured visual sources. */
  search: (query: string) => Promise<Candidate[]>;
  /** Results requested per query. */
  perQuery?: number;
}

// ── Report ────────────────────────────────────────────────────────────────

export interface PredictedBeat {
  index: number;
  startS: number;
  endS: number;
  durationS: number;
  narration: string;
  segmentIndex: number;
  /** Assets predicted to fill this beat, in order. */
  fragments: {
    assetId: string;
    description: string;
    durationS: number;
    relevanceScore: number;
    verdict: string;
    concept: string;
    brandRisk: boolean;
  }[];
  /** Seconds of this beat predicted to fall back to a branded card. */
  cardSecondsS: number;
  /** True when any part of this beat falls back to a card. */
  hasCard: boolean;
}

export interface FeasibilityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface FeasibilityReport {
  // ── Identity ────────────────────────────────────────────────────────
  topic: string;
  channel: ChannelKey;
  targetRuntimeS: number;
  /** Runtime minus the title card — the span visuals must actually cover. */
  plannedVisualDurationS: number;
  expectedBeatCount: number;

  // ── Retrieval ───────────────────────────────────────────────────────
  searchQueries: string[];
  totalCandidates: number;
  relevantCandidates: number;
  strongCandidates: number;
  acceptableCandidates: number;
  genericCandidates: number;
  rejectedCandidates: number;
  brandRiskCandidates: number;

  // ── Accepted pool ───────────────────────────────────────────────────
  uniqueUsableAssets: number;
  /** Unique usable assets that carry no brand risk. */
  uniqueUsableAssetsExcludingBrandRisk: number;
  totalUsableDurationS: number;
  minUniqueAssetsRequired: number;
  requiredPoolWithSafety: number;
  conceptBreakdown: { concept: string; assets: number; projectedSeconds: number; share: number }[];
  distinctConcepts: number;

  // ── Simulated timeline ──────────────────────────────────────────────
  predictedBeats: PredictedBeat[];
  estimatedCardCount: number;
  estimatedCardPct: number;
  estimatedConsecutiveCardRisk: number;

  // ── Verdict ─────────────────────────────────────────────────────────
  checks: FeasibilityCheck[];
  pass: boolean;
  failureReason: string | null;
}

// ── Preliminary beat planning (no word alignment available) ───────────────

/**
 * Plan the beat timeline BEFORE narration exists.
 *
 * `planSegmentBeats` needs real per-word timings from the ElevenLabs
 * alignment, which is precisely what has not been bought yet.
 *
 * The timeline length comes from the TARGET RUNTIME, never from the length of
 * the outline text. An outline is a sketch — five paragraphs of a hundred
 * words each describe a six-minute video perfectly well. Deriving beat count
 * from the sketch would have told the gate this was a 97-second video needing
 * five assets, and a 97-second video is trivially feasible. The question being
 * asked is whether the FINISHED video can be illustrated, so the finished
 * runtime is what gets planned.
 *
 * Each segment receives a share of the runtime proportional to its weight in
 * the outline, then that share is divided into beats of BEAT_TARGET_S, held
 * within BEAT_MIN_S..BEAT_MAX_S. Beats carry their segment's sentences so
 * relevance scoring has real narration to judge against.
 */
export function planPreliminaryBeats(
  segments: OutlineSegment[],
  channel: ChannelKey,
  plannedVisualDurationS: number,
): Omit<PredictedBeat, "fragments" | "cardSecondsS" | "hasCard">[] {
  void channel; // rate is only needed when deriving duration FROM text
  const beats: Omit<PredictedBeat, "fragments" | "cardSecondsS" | "hasCard">[] = [];
  if (segments.length === 0 || plannedVisualDurationS <= 0) return beats;

  const weights = segments.map((s) => Math.max(1, s.narration.trim().length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let clock = 0;
  segments.forEach((seg, i) => {
    // Last segment absorbs rounding so the beats tile the runtime exactly.
    const share = i === segments.length - 1
      ? plannedVisualDurationS - clock
      : (weights[i] / totalWeight) * plannedVisualDurationS;
    if (share <= 0) return;

    // How many beats this segment's share wants, at the target beat length.
    let count = Math.max(1, Math.round(share / BEAT_TARGET_S));
    // Respect the hard cap: a segment long enough to need more beats gets them.
    count = Math.max(count, Math.ceil(share / BEAT_MAX_S));
    // And the floor: never emit beats shorter than BEAT_MIN_S.
    count = Math.min(count, Math.max(1, Math.floor(share / BEAT_MIN_S)));

    const beatDur = share / count;
    const sentences = seg.narration
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (let b = 0; b < count; b++) {
      // Spread the segment's sentences across its beats so each beat is scored
      // against the part of the narrative it actually sits under.
      const narration = sentences.length
        ? sentences[Math.min(sentences.length - 1, Math.floor((b * sentences.length) / count))]
        : seg.narration;
      beats.push({
        index: 0,
        startS: clock,
        endS: clock + beatDur,
        durationS: beatDur,
        narration,
        segmentIndex: seg.segmentIndex,
      });
      clock += beatDur;
    }
  });

  return beats.map((b, i) => ({ ...b, index: i + 1 }));
}

// ── Candidate gathering ───────────────────────────────────────────────────

/** Build the queries assembly would build, across the whole outline. */
export function feasibilityQueries(input: FeasibilityInput): string[] {
  const queries: string[] = [];
  for (const seg of input.segments) {
    queries.push(...buildSearchQueries(seg.visual_prompt, seg.title, input.channel));
  }
  return [...new Set(queries)];
}

interface ScoredCandidate {
  candidate: Candidate;
  relevance: RelevanceResult;
  brandRisk: boolean;
  /** Seconds of timeline this asset can contribute, at most. */
  usableS: number;
}

/**
 * Move a long clip to a beat that cannot close itself, and backfill its origin.
 *
 * Called once, only when the projected timeline contains adjacent fallback
 * cards. Returns a note per repair applied; an empty list means nothing could
 * be improved and the checks below will fail the candidate exactly as before.
 *
 * A swap is only offered when every one of these holds, so no gate can be
 * traded away to satisfy another:
 *
 *   - the donated asset can close the carding beat outright (usableS >= the
 *     residual), so the card disappears rather than shrinking
 *   - the donated asset is genuinely relevant to the beat it moves TO, judged
 *     by the same `scoreRelevance` and the same REJECT_THRESHOLD as any other
 *     assignment — relevance is never relaxed to avoid a card
 *   - the backfill asset is unused, so no asset appears twice
 *   - the backfill covers exactly the seconds it replaces, so the donor beat
 *     does not acquire a card of its own and the timeline still adds up
 *   - the backfill is relevant to the beat it moves INTO, on the same terms
 *
 * Ranked so the best repair is taken first: prefer the strongest relevance on
 * the carding beat, then avoid brand-risk footage, then prefer the strongest
 * backfill. Ties break on asset id so the plan is reproducible.
 */
function repairConsecutiveCards(input: {
  predicted: PredictedBeat[];
  accepted: ScoredCandidate[];
  ledger: AssetLedger;
  channel: ChannelKey;
  segments: OutlineSegment[];
}): string[] {
  const { predicted, accepted, ledger, channel, segments } = input;
  const notes: string[] = [];

  const pairs: number[] = [];
  for (let i = 1; i < predicted.length; i++) {
    if (predicted[i]!.hasCard && predicted[i - 1]!.hasCard) pairs.push(i);
  }
  if (pairs.length === 0) return notes;

  const byId = new Map(accepted.map((a) => [a.candidate.assetId, a]));
  const promptFor = (b: PredictedBeat) =>
    (segments[b.segmentIndex] ?? segments[segments.length - 1])!.visual_prompt;
  const rel = (b: PredictedBeat, description: string) =>
    scoreRelevance({ channel, narration: b.narration, prompt: promptFor(b), description });

  for (const i of pairs) {
    // Fixing either member breaks the adjacency; try the one with the smaller
    // residual first, since it is the easier beat to close.
    const targets = [predicted[i]!, predicted[i - 1]!]
      .filter((b) => b.hasCard)
      .sort((a, b) => a.cardSecondsS - b.cardSecondsS);

    for (const target of targets) {
      if (!target.hasCard) continue;
      const need = target.cardSecondsS;

      interface Option {
        donorBeat: PredictedBeat; donorIdx: number; donorAsset: ScoredCandidate;
        backfill: ScoredCandidate; targetScore: number; targetVerdict: string;
        backfillScore: number; brandRisk: boolean;
      }
      const options: Option[] = [];

      for (const donorBeat of predicted) {
        if (donorBeat.index === target.index) continue;
        for (let fi = 0; fi < donorBeat.fragments.length; fi++) {
          const frag = donorBeat.fragments[fi]!;
          const donorAsset = byId.get(frag.assetId);
          if (!donorAsset || donorAsset.usableS < need) continue;

          // Must be a legitimate assignment on the beat it moves to.
          const tScore = rel(target, donorAsset.candidate.description ?? "");
          if (tScore.verdict === "REJECT" || tScore.score < REJECT_THRESHOLD) continue;

          for (const backfill of accepted) {
            if (!ledger.isAvailable(backfill.candidate.assetId)) continue;
            if (backfill.candidate.assetId === donorAsset.candidate.assetId) continue;
            // Must cover exactly the seconds it replaces.
            if (backfill.usableS < frag.durationS) continue;
            const fit = fitFragment(frag.durationS, backfill.usableS);
            if (!fit || Math.abs(fit.useS - frag.durationS) > 0.01) continue;
            const bScore = rel(donorBeat, backfill.candidate.description ?? "");
            if (bScore.verdict === "REJECT" || bScore.score < REJECT_THRESHOLD) continue;
            options.push({
              donorBeat, donorIdx: fi, donorAsset, backfill,
              targetScore: tScore.score, targetVerdict: tScore.verdict,
              backfillScore: bScore.score,
              brandRisk: donorAsset.brandRisk || backfill.brandRisk,
            });
            break; // best available backfill for this donor fragment is enough
          }
        }
      }
      if (options.length === 0) continue;

      options.sort((a, b) =>
        Number(a.brandRisk) - Number(b.brandRisk) ||
        b.targetScore - a.targetScore ||
        b.backfillScore - a.backfillScore ||
        a.donorAsset.candidate.assetId.localeCompare(b.donorAsset.candidate.assetId));
      const pick = options[0]!;

      // Apply: the donor's clip closes the carding beat, and an unused clip
      // takes its place. Durations are preserved on both sides.
      const frag = pick.donorBeat.fragments[pick.donorIdx]!;
      const bRel = rel(pick.donorBeat, pick.backfill.candidate.description ?? "");
      pick.donorBeat.fragments[pick.donorIdx] = {
        assetId: pick.backfill.candidate.assetId,
        description: pick.backfill.candidate.description ?? "",
        durationS: frag.durationS,
        relevanceScore: bRel.score,
        verdict: bRel.verdict,
        concept: bRel.concept,
        brandRisk: pick.backfill.brandRisk,
      };
      ledger.claim(pick.backfill.candidate.assetId);

      const tRel = rel(target, pick.donorAsset.candidate.description ?? "");
      target.fragments.push({
        assetId: pick.donorAsset.candidate.assetId,
        description: pick.donorAsset.candidate.description ?? "",
        durationS: need,
        relevanceScore: tRel.score,
        verdict: tRel.verdict,
        concept: tRel.concept,
        brandRisk: pick.donorAsset.brandRisk,
      });
      target.cardSecondsS = 0;
      target.hasCard = false;

      notes.push(
        `repaired consecutive cards at beat ${target.index}: moved ${pick.donorAsset.candidate.assetId} ` +
        `(${tRel.verdict} ${tRel.score.toFixed(2)}) from beat ${pick.donorBeat.index} to close ${need.toFixed(1)}s, ` +
        `backfilled with ${pick.backfill.candidate.assetId} (${bRel.verdict} ${bRel.score.toFixed(2)})`);
      break; // this pair is resolved
    }
  }
  return notes;
}

// ── The gate ──────────────────────────────────────────────────────────────

export async function assessVisualFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDeps,
): Promise<FeasibilityReport> {
  const plannedVisualDurationS = input.targetRuntimeS - TITLE_CARD_S;
  const beats = planPreliminaryBeats(input.segments, input.channel, plannedVisualDurationS);
  const queries = feasibilityQueries(input);

  // ── 1. Retrieve, de-duplicated by asset id ──────────────────────────
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (const q of queries) {
    for (const c of await deps.search(q)) {
      if (seen.has(c.assetId)) continue;
      seen.add(c.assetId);
      pool.push(c);
    }
  }

  // ── 2. Score every candidate against the beat it best fits ──────────
  //
  // A candidate is judged against the narration it would actually sit under.
  // Scoring it against the whole script would inflate relevance for footage
  // that matches nothing in particular.
  let strong = 0, acceptable = 0, generic = 0, rejected = 0, brandRisk = 0;
  const accepted: ScoredCandidate[] = [];

  for (const c of pool) {
    let best: { r: RelevanceResult; segIndex: number; narration: string } | null = null;
    for (const beat of beats) {
      const seg = input.segments[beat.segmentIndex] ?? input.segments[input.segments.length - 1];
      const r = scoreRelevance({
        channel: input.channel,
        narration: beat.narration,
        prompt: seg.visual_prompt,
        description: c.description ?? "",
      });
      if (!best || r.score > best.r.score) {
        best = { r, segIndex: beat.segmentIndex, narration: beat.narration };
      }
    }
    if (!best) continue;
    const r = best.r;

    // Brand risk is measured on every candidate, including rejected ones, so
    // the report shows the true composition of what the source returned.
    const seg = input.segments[best.segIndex] ?? input.segments[0];
    const brand = checkBrandFromMetadata(
      `${c.description ?? ""} ${c.pageUrl ?? ""}`, seg.visual_prompt, best.narration,
    );
    const risky = isHighBrandRiskFootage(c.description ?? "") || brand.visibleBrandDetected;
    if (risky) brandRisk += 1;

    // Sub-threshold footage counts toward NOTHING. This is the rule that the
    // HBM run's earlier revisions kept eroding: a GENERIC asset scoring below
    // the reject threshold was still consuming a slot.
    if (r.verdict === "REJECT" || r.score < REJECT_THRESHOLD) { rejected += 1; continue; }
    // Irrelevant visible branding is a hard reject, exactly as in assembly.
    if (!brandAdmits(brand)) { rejected += 1; continue; }
    // Resolution / orientation floor.
    if (!validateCandidateMeta(c, MIN_FRAGMENT_S).ok) { rejected += 1; continue; }
    // A source shorter than the minimum fragment cannot fill any part of a
    // beat without looping, which is forbidden.
    if (c.durationS > 0 && c.durationS < MIN_FRAGMENT_S) { rejected += 1; continue; }

    if (r.verdict === "STRONG") strong += 1;
    else if (r.verdict === "GENERIC") generic += 1;
    else acceptable += 1;

    accepted.push({
      candidate: c,
      relevance: r,
      brandRisk: risky,
      // An asset can never contribute more than one beat's worth of timeline,
      // because assembly caps a single clip at BEAT_MAX_S and never reuses it.
      usableS: Math.min(c.durationS || 0, BEAT_MAX_S),
    });
  }

  const totalUsableDurationS = accepted.reduce((a, x) => a + x.usableS, 0);

  // ── 3. Minimum unique assets the timeline demands ───────────────────
  //
  // Each beat needs at least one asset; a beat longer than the longest usable
  // clip needs several fragments. This is a floor, not a forecast.
  const minUniqueAssetsRequired = beats.reduce(
    (a, b) => a + Math.max(1, Math.ceil(b.durationS / BEAT_MAX_S)), 0,
  );
  const requiredPoolWithSafety = Math.ceil(minUniqueAssetsRequired * POOL_SAFETY_FACTOR);

  // ── 4. Simulate the timeline exactly as renderBeat would build it ───
  const ledger = new AssetLedger(1);
  const plan = new VisualPlan();
  const predicted: PredictedBeat[] = [];

  for (const beat of beats) {
    const seg = input.segments[beat.segmentIndex] ?? input.segments[input.segments.length - 1];
    // Re-score against THIS beat's narration — the same thing renderBeat does.
    const scored = accepted
      .map((x) => ({
        x,
        r: scoreRelevance({
          channel: input.channel,
          narration: beat.narration,
          prompt: seg.visual_prompt,
          description: x.candidate.description ?? "",
        }),
      }))
      .sort((a, b) => b.r.score - a.r.score);

    const tried = new Set<string>();
    const fragments: PredictedBeat["fragments"] = [];
    let remaining = beat.durationS;

    while (remaining >= MIN_FRAGMENT_S) {
      const ranked = scored
        .filter((s) => !tried.has(s.x.candidate.assetId) && ledger.isAvailable(s.x.candidate.assetId))
        .map((s) => ({ candidate: s.x, relevance: s.r }));
      const pick = plan.selectCandidate(ranked, (c) => ledger.isAvailable(c.candidate.assetId));
      if (!pick) break;

      const chosen = pick.candidate;
      tried.add(chosen.candidate.assetId);

      // Identical fitting rule to assembly — see fitFragment.
      const fit = fitFragment(remaining, chosen.usableS);
      if (!fit) continue;
      const useDur = fit.useS;

      ledger.claim(chosen.candidate.assetId);
      plan.claim(pick.relevance);
      fragments.push({
        assetId: chosen.candidate.assetId,
        description: chosen.candidate.description ?? "",
        durationS: useDur,
        relevanceScore: pick.relevance.score,
        verdict: pick.relevance.verdict,
        concept: pick.relevance.concept,
        brandRisk: chosen.brandRisk,
      });
      remaining -= useDur;
    }

    predicted.push({
      ...beat,
      fragments,
      cardSecondsS: remaining > 0.5 ? remaining : 0,
      hasCard: remaining > 0.5,
    });
  }

  // ── 4b. Bounded repair of consecutive fallback cards ────────────────
  //
  // Two cards in a row is a real defect and stays prohibited. But it is often
  // an ARRANGEMENT defect rather than a shortage: the assignment loop above is
  // greedy and single-pass, and the ledger allows each asset once, so a long
  // clip can be spent on an early beat that a short clip would have served just
  // as well. A later beat is then left with 6-12 seconds it cannot close,
  // because `fitFragment` refuses anything that would leave a sliver — and by
  // then every asset long enough is already claimed.
  //
  // The candidate that motivated this had 237 usable assets for 23 beats, 2
  // predicted cards, every other check passing, and failed on a single adjacent
  // pair. Refusing it wasted an authorized production attempt over an ordering
  // artefact.
  //
  // So: one pass, deterministic, and only ever a SWAP. A long asset already
  // assigned elsewhere moves to the carding beat, and the beat it came from is
  // backfilled with an unused asset that covers exactly the same seconds. Total
  // screen time, uniqueness and coverage are unchanged by construction; the
  // only thing that changes is which beat gets which clip.
  //
  // Everything is re-checked afterwards against the repaired timeline — this
  // runs BEFORE the statistics and the checks below, so nothing is graded on
  // the pre-repair arrangement.
  const repairNotes = repairConsecutiveCards({
    predicted, accepted, ledger, channel: input.channel, segments: input.segments,
  });
  if (repairNotes.length > 0) for (const n of repairNotes) console.log(`[feasibility] ${n}`);

  // ── 5. Timeline statistics ──────────────────────────────────────────
  //
  // A beat that falls back to a card contributes one card to the timeline, so
  // the share is measured over beats — the unit a viewer actually perceives as
  // "another card".
  const estimatedCardCount = predicted.filter((b) => b.hasCard).length;
  const estimatedCardPct = predicted.length
    ? (estimatedCardCount / predicted.length) * 100
    : 100;

  let consecutiveCardRisk = 0;
  for (let i = 1; i < predicted.length; i++) {
    if (predicted[i].hasCard && predicted[i - 1].hasCard) consecutiveCardRisk += 1;
  }

  // Concept concentration over the PROJECTED timeline, weighted by seconds.
  const conceptSeconds = new Map<string, { seconds: number; assets: Set<string> }>();
  for (const b of predicted) {
    for (const f of b.fragments) {
      const e = conceptSeconds.get(f.concept) ?? { seconds: 0, assets: new Set<string>() };
      e.seconds += f.durationS;
      e.assets.add(f.assetId);
      conceptSeconds.set(f.concept, e);
    }
  }
  const projectedSeconds = [...conceptSeconds.values()].reduce((a, e) => a + e.seconds, 0) || 1;
  const conceptBreakdown = [...conceptSeconds.entries()]
    .map(([concept, e]) => ({
      concept,
      assets: e.assets.size,
      projectedSeconds: Number(e.seconds.toFixed(1)),
      share: Number((e.seconds / projectedSeconds).toFixed(3)),
    }))
    .sort((a, b) => b.projectedSeconds - a.projectedSeconds);

  // "Distinct, concrete visual categories" — generic-abstract is not one,
  // "none" means the scorer could not name a subject at all, and "ambiguous"
  // means the evidence tied between concepts. None of them is a category a
  // viewer would perceive, so none may help satisfy MIN_DISTINCT_CONCEPTS.
  // They remain in conceptBreakdown, so a plan dominated by unnameable
  // footage still fails the share cap.
  const distinctConcepts = conceptBreakdown.filter(
    (c) => c.concept !== "generic-abstract" && c.concept !== "none"
      && c.concept !== "card" && c.concept !== "ambiguous",
  ).length;

  const uniqueUsableAssets = accepted.length;
  const uniqueUsableAssetsExcludingBrandRisk = accepted.filter((x) => !x.brandRisk).length;

  // ── 6. Checks ───────────────────────────────────────────────────────
  const policy = feasibilityPolicyFor(input.channel);
  const checks: FeasibilityCheck[] = [
    {
      name: "fallback-card-share",
      ok: estimatedCardPct <= MAX_CARD_SHARE * 100,
      detail: `${estimatedCardCount}/${predicted.length} beats (${estimatedCardPct.toFixed(1)}%) predicted to fall back to a card; cap ${MAX_CARD_SHARE * 100}%`,
    },
    {
      name: "no-consecutive-cards",
      ok: consecutiveCardRisk === 0,
      detail: consecutiveCardRisk === 0
        ? "no two predicted cards are consecutive"
        : `${consecutiveCardRisk} consecutive card pair(s) predicted`,
    },
    {
      name: "unique-assets-cover-timeline",
      ok: uniqueUsableAssets >= minUniqueAssetsRequired,
      detail: `${uniqueUsableAssets} unique usable asset(s) for a timeline needing at least ${minUniqueAssetsRequired} without reuse`,
    },
    {
      name: "pool-safety-margin",
      ok: uniqueUsableAssets >= requiredPoolWithSafety,
      detail: `${uniqueUsableAssets} accepted vs ${requiredPoolWithSafety} required (${minUniqueAssetsRequired} × ${POOL_SAFETY_FACTOR})`,
    },
    {
      name: "usable-duration-margin",
      ok: totalUsableDurationS >= plannedVisualDurationS * DURATION_SAFETY_FACTOR,
      detail: `${totalUsableDurationS.toFixed(0)}s usable source vs ${(plannedVisualDurationS * DURATION_SAFETY_FACTOR).toFixed(0)}s required (${plannedVisualDurationS.toFixed(0)}s × ${DURATION_SAFETY_FACTOR})`,
    },
    {
      name: "brand-risk-not-load-bearing",
      ok: uniqueUsableAssetsExcludingBrandRisk >= minUniqueAssetsRequired,
      detail: `${uniqueUsableAssetsExcludingBrandRisk} non-brand-risk asset(s) vs ${minUniqueAssetsRequired} minimum — brand-risk footage must not be the only way to reach the minimum`,
    },
    {
      name: "concept-diversity",
      ok: distinctConcepts >= MIN_DISTINCT_CONCEPTS,
      detail: `${distinctConcepts} distinct concrete visual category/ies (need ${MIN_DISTINCT_CONCEPTS}): ${conceptBreakdown.map((c) => c.concept).join(", ") || "none"}`,
    },
    {
      name: "no-dominant-concept",
      // Still measured and still reported on every channel — the number is
      // useful diagnostics. Whether it may FAIL a candidate is the policy.
      ok: !policy.enforceDominantConceptCap
        || (conceptBreakdown[0]?.share ?? 0) <= MAX_CONCEPT_SHARE,
      detail: conceptBreakdown[0]
        ? `largest concept "${conceptBreakdown[0].concept}" holds ${(conceptBreakdown[0].share * 100).toFixed(0)}% of projected timeline` +
          (policy.enforceDominantConceptCap
            ? `; cap ${MAX_CONCEPT_SHARE * 100}%`
            : "; DIAGNOSTIC ONLY — cap retired for this channel, see FEASIBILITY_POLICY")
        : "no concepts projected",
    },
  ];

  const failed = checks.filter((c) => !c.ok);

  return {
    topic: input.topicTitle,
    channel: input.channel,
    targetRuntimeS: input.targetRuntimeS,
    plannedVisualDurationS,
    expectedBeatCount: beats.length,

    searchQueries: queries,
    totalCandidates: pool.length,
    relevantCandidates: strong + acceptable + generic,
    strongCandidates: strong,
    acceptableCandidates: acceptable,
    genericCandidates: generic,
    rejectedCandidates: rejected,
    brandRiskCandidates: brandRisk,

    uniqueUsableAssets,
    uniqueUsableAssetsExcludingBrandRisk,
    totalUsableDurationS: Number(totalUsableDurationS.toFixed(1)),
    minUniqueAssetsRequired,
    requiredPoolWithSafety,
    conceptBreakdown,
    distinctConcepts,

    predictedBeats: predicted,
    estimatedCardCount,
    estimatedCardPct: Number(estimatedCardPct.toFixed(1)),
    estimatedConsecutiveCardRisk: consecutiveCardRisk,

    checks,
    pass: failed.length === 0,
    failureReason: failed.length === 0
      ? null
      : failed.map((c) => `${c.name}: ${c.detail}`).join(" | "),
  };
}

// ── Default source binding ────────────────────────────────────────────────

/**
 * The gate against the sources the pipeline is currently configured to use.
 *
 * Today that is Pexels alone. When another provider is added, it is added
 * here and every feasibility verdict changes accordingly — which is the point:
 * feasibility is a property of the topic AND the library, never of the topic
 * on its own.
 */
export function pexelsOnlySource(apiKey: string, perQuery = 40): FeasibilityDeps {
  return {
    perQuery,
    search: (query: string) => searchPexelsCandidates(query, apiKey, { perPage: perQuery }),
  };
}

export class VisualFeasibilityError extends Error {
  constructor(readonly report: FeasibilityReport) {
    super(
      `Visual feasibility FAILED for "${report.topic}" — no narration will be purchased. ` +
        `${report.failureReason}`,
    );
    this.name = "VisualFeasibilityError";
  }
}

/**
 * Fail-closed wrapper. Call this, not `assessVisualFeasibility`, from any code
 * path that is about to spend ElevenLabs credits.
 */
export async function assertVisuallyFeasible(
  input: FeasibilityInput,
  deps: FeasibilityDeps,
): Promise<FeasibilityReport> {
  const report = await assessVisualFeasibility(input, deps);
  if (!report.pass) throw new VisualFeasibilityError(report);
  return report;
}

/**
 * Run the gate, and only then buy narration.
 *
 * The ordering is the whole point of this module, so it is expressed as one
 * function rather than left as a convention two call sites are expected to
 * remember. `purchaseNarration` is not invoked at all when feasibility fails,
 * which is what makes "a failed check costs zero credits" a structural
 * property instead of a hope.
 */
export async function withVisualFeasibilityGate<T>(
  input: FeasibilityInput,
  deps: FeasibilityDeps,
  purchaseNarration: (report: FeasibilityReport) => Promise<T>,
): Promise<{ report: FeasibilityReport; result: T }> {
  const report = await assertVisuallyFeasible(input, deps);
  return { report, result: await purchaseNarration(report) };
}

// ── Reporting ─────────────────────────────────────────────────────────────

export function formatFeasibility(r: FeasibilityReport): string {
  const lines: string[] = [];
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  lines.push(`── visual feasibility: ${r.topic} ──`);
  lines.push(`  channel            : ${r.channel}`);
  lines.push(`  target runtime     : ${mm(r.targetRuntimeS)} (${r.plannedVisualDurationS.toFixed(0)}s of visuals)`);
  lines.push(`  expected beats     : ${r.expectedBeatCount}`);
  lines.push(`  search queries     : ${r.searchQueries.length}`);
  lines.push(`  candidates         : ${r.totalCandidates} total`);
  lines.push(`    relevant         : ${r.relevantCandidates}  (STRONG ${r.strongCandidates}, ACCEPTABLE ${r.acceptableCandidates}, GENERIC ${r.genericCandidates})`);
  lines.push(`    rejected         : ${r.rejectedCandidates}`);
  lines.push(`    brand-risk       : ${r.brandRiskCandidates}`);
  lines.push(`  unique usable      : ${r.uniqueUsableAssets} (${r.uniqueUsableAssetsExcludingBrandRisk} without brand risk)`);
  lines.push(`  usable duration    : ${r.totalUsableDurationS}s`);
  lines.push(`  min assets needed  : ${r.minUniqueAssetsRequired} (with safety: ${r.requiredPoolWithSafety})`);
  lines.push(`  estimated cards    : ${r.estimatedCardCount} (${r.estimatedCardPct}%)`);
  lines.push(`  consecutive cards  : ${r.estimatedConsecutiveCardRisk}`);
  lines.push(`  concepts           : ${r.conceptBreakdown.map((c) => `${c.concept}=${(c.share * 100).toFixed(0)}%`).join(" ") || "none"}`);
  lines.push("");
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(28)} ${c.detail}`);
  }
  lines.push("");
  lines.push(`  VERDICT: ${r.pass ? "PASS — safe to purchase narration" : "FAIL — narration must NOT be purchased"}`);
  if (r.failureReason) lines.push(`  reason : ${r.failureReason}`);
  return lines.join("\n");
}
