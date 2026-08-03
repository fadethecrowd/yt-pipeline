import { createHash } from "node:crypto";

/**
 * Rendering a human-approved visual allocation verbatim.
 *
 * The assembly path plans its own beats and searches Pexels at render time.
 * That is right when nobody has reviewed the footage, and wrong once a human
 * has inspected specific clips and approved them: re-acquiring would render
 * footage the reviewer never saw while carrying an approval given to something
 * else. This module carries an approved allocation into assembly so the
 * renderer uses exactly the assets that were signed off.
 *
 * Narration alignment is allowed to move beat boundaries by a little, so
 * fragment durations scale proportionally inside each beat. Nothing else may
 * move: not the assets, not their order, not the cards, not the continuations.
 */

/** One clip inside a beat, at its approved position. */
export interface ApprovedFragment {
  assetId: string;
  /** Seconds of this clip planned for this beat, before alignment. */
  plannedDurationS: number;
  /** Full length of the source, the hard ceiling on any adjustment. */
  sourceDurationS: number;
  /** Set when this clip runs on into the next beat as one continuous take. */
  continuesIntoBeat?: number;
  continuationSeconds?: number;
  description?: string;
  pageUrl?: string | null;
}

export interface ApprovedBeat {
  beat: number;
  /** Planned length before alignment. */
  durationS: number;
  narration: string;
  fragments: ApprovedFragment[];
  /** Time carried in from the previous beat's continuing clip. */
  continuedFrom?: { assetId: string; fromBeat: number; seconds: number };
  hasCard?: boolean;
  cardSecondsS?: number;
  cardText?: string | null;
}

export interface ApprovedAllocation {
  scriptSha256: string;
  beats: ApprovedBeat[];
  /** Where the human approval came from, carried into the hash. */
  provenance: {
    reviewForm: string;
    reviewSha256: string;
    profile: string;
    decisions: Record<string, number>;
  };
}

/** Shortest fragment worth cutting; mirrors the assembly floor. */
export const MIN_FRAGMENT_S = 3;

// ── Identity ─────────────────────────────────────────────────────────────

/**
 * Hash of what was approved. Covers the script, the ordered asset ids, the
 * planned in/out points, the cards and the continuations, plus the review
 * provenance — so a render can prove which approval it was built from.
 */
export function approvedAllocationHash(a: ApprovedAllocation): string {
  const canonical = JSON.stringify({
    script: a.scriptSha256,
    beats: a.beats.map((b) => ({
      beat: b.beat,
      assets: b.fragments.map((f) => ({
        id: f.assetId,
        planned: +f.plannedDurationS.toFixed(3),
        continuesInto: f.continuesIntoBeat ?? null,
        continuationS: f.continuationSeconds ?? null,
      })),
      continuedFrom: b.continuedFrom
        ? { id: b.continuedFrom.assetId, from: b.continuedFrom.fromBeat, s: b.continuedFrom.seconds }
        : null,
      card: b.hasCard ? { s: b.cardSecondsS, text: b.cardText } : null,
    })),
    provenance: a.provenance,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RealizedFragment {
  assetId: string;
  beat: number;
  sourceInS: number;
  sourceOutS: number;
  durationS: number;
  continuesIntoBeat?: number;
}

export interface RealizedTimeline {
  approvedAllocationHash: string;
  audioSha256: string;
  beats: {
    beat: number; startS: number; durationS: number;
    fragments: RealizedFragment[];
    continuedFromSeconds: number;
    cardSecondsS: number;
  }[];
  totalDurationS: number;
}

/** Hash of what was actually built, for audit against the approval. */
export function realizedTimelineHash(t: RealizedTimeline): string {
  return createHash("sha256").update(JSON.stringify({
    approved: t.approvedAllocationHash,
    audio: t.audioSha256,
    beats: t.beats.map((b) => ({
      beat: b.beat, start: +b.startS.toFixed(3), dur: +b.durationS.toFixed(3),
      frags: b.fragments.map((f) => ({ id: f.assetId, in: +f.sourceInS.toFixed(3),
        out: +f.sourceOutS.toFixed(3), dur: +f.durationS.toFixed(3) })),
      cont: +b.continuedFromSeconds.toFixed(3), card: +b.cardSecondsS.toFixed(3),
    })),
    total: +t.totalDurationS.toFixed(3),
  })).digest("hex");
}

// ── Alignment ────────────────────────────────────────────────────────────

export class AllocationConflictError extends Error {
  constructor(message: string) { super(message); this.name = "AllocationConflictError"; }
}

/**
 * Fit the approved beats to the durations narration actually came out at.
 *
 * Cards keep their approved length exactly — they were approved as readable at
 * that length. Continuations keep their exact carried seconds, because the
 * clip has to reach the same point in the next beat to stay one take. Whatever
 * remains is shared across the beat's own fragments in their approved
 * proportions.
 *
 * Throws rather than improvising if a beat cannot be covered by its approved
 * assets within their real source lengths.
 */
export function alignToNarration(
  alloc: ApprovedAllocation,
  actualBeatDurations: Map<number, number>,
): ApprovedBeat[] {
  return alloc.beats.map((b) => {
    const target = actualBeatDurations.get(b.beat);
    if (target === undefined) throw new AllocationConflictError(`no aligned duration for beat ${b.beat}`);

    const card = b.hasCard ? (b.cardSecondsS ?? 0) : 0;
    const carriedIn = b.continuedFrom ? b.continuedFrom.seconds : 0;
    // Seconds this beat's own fragments must cover.
    let own = +(target - card - carriedIn).toFixed(3);
    if (own < 0) {
      throw new AllocationConflictError(
        `beat ${b.beat}: card ${card}s + carried-in ${carriedIn}s exceeds the aligned ${target}s`,
      );
    }

    // Each fragment's own share excludes any seconds it spends in the NEXT beat.
    const ownPlanned = b.fragments.map((f) => f.plannedDurationS - (f.continuationSeconds ?? 0));
    const plannedTotal = ownPlanned.reduce((a, x) => a + x, 0);
    if (plannedTotal <= 0) {
      if (own > 0.05) {
        throw new AllocationConflictError(`beat ${b.beat}: ${own}s to cover but no fragment carries it`);
      }
      return { ...b, durationS: target };
    }

    const scale = own / plannedTotal;
    const fragments = b.fragments.map((f, i) => {
      const scaled = +(ownPlanned[i]! * scale).toFixed(3);
      const carriesOut = f.continuationSeconds ?? 0;
      const total = +(scaled + carriesOut).toFixed(3);
      if (total > f.sourceDurationS + 1e-6) {
        throw new AllocationConflictError(
          `beat ${b.beat}: ${f.assetId} would need ${total}s of a ${f.sourceDurationS}s source`,
        );
      }
      if (scaled < MIN_FRAGMENT_S && b.fragments.length > 1) {
        throw new AllocationConflictError(
          `beat ${b.beat}: ${f.assetId} shrinks to ${scaled}s, below the ${MIN_FRAGMENT_S}s floor`,
        );
      }
      return { ...f, plannedDurationS: total };
    });
    return { ...b, durationS: target, fragments };
  });
}

/**
 * Prove the allocation survives the alignment variation narration may produce,
 * BEFORE any credits are spent. Every beat is tested shortened and lengthened.
 */
export function validateTimingEnvelope(
  alloc: ApprovedAllocation,
  tolerance = 0.1,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const factor of [1 - tolerance, 1, 1 + tolerance]) {
    const durations = new Map(alloc.beats.map((b) => [b.beat, +(b.durationS * factor).toFixed(3)]));
    try {
      alignToNarration(alloc, durations);
    } catch (e) {
      failures.push(`${(factor * 100).toFixed(0)}%: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── Fail-closed verification ─────────────────────────────────────────────

/**
 * The render must be built from the approved assets, in the approved order,
 * with nothing added and nothing missing. Any divergence fails closed.
 */
export function assertRealizedMatchesApproved(
  alloc: ApprovedAllocation,
  realizedAssetIdsInOrder: string[],
): void {
  const approved = alloc.beats.flatMap((b) => b.fragments.map((f) => f.assetId));
  if (realizedAssetIdsInOrder.length !== approved.length) {
    throw new AllocationConflictError(
      `render used ${realizedAssetIdsInOrder.length} assets, approval has ${approved.length}`,
    );
  }
  for (let i = 0; i < approved.length; i++) {
    if (realizedAssetIdsInOrder[i] !== approved[i]) {
      throw new AllocationConflictError(
        `asset order diverged at position ${i}: approved ${approved[i]}, rendered ${realizedAssetIdsInOrder[i]}`,
      );
    }
  }
  const a = new Set(approved), r = new Set(realizedAssetIdsInOrder);
  for (const id of a) if (!r.has(id)) throw new AllocationConflictError(`approved asset ${id} disappeared`);
  for (const id of r) if (!a.has(id)) throw new AllocationConflictError(`unapproved asset ${id} appeared`);
  if (new Set(approved).size !== approved.length) {
    throw new AllocationConflictError("approved allocation contains a duplicate asset");
  }
}
