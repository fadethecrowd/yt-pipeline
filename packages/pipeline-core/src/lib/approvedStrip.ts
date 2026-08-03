import { MIN_FRAGMENT_S, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, AllocationConflictError } from "./approvedAllocation";
import type { ApprovedBeat, ApprovedFragment } from "./approvedAllocation";
import { BEAT_MAX_S } from "./visualBeats";

/**
 * Lay an approved set of clips down as ONE continuous strip and cut beats from it.
 *
 * The alternative — freezing per-beat fragment durations and scaling them when
 * the real narration turns out longer or shorter — cannot express a clip that
 * spans a beat boundary. Scaling moves the boundary but not the carried
 * seconds, so a beat covered entirely by its predecessor's clip ends up with
 * time to fill and nothing to fill it with.
 *
 * More importantly the renderer cuts every fragment from the START of its
 * source. A clip listed once per beat it touches therefore replays its own
 * opening three times rather than running on — a loop, which is exactly what
 * the approval forbids. So a clip appears exactly ONCE, in the beat where it
 * starts, with the full screen time it occupies; `continuesIntoBeat` records
 * that it runs past the boundary.
 *
 * Identity is frozen: the same assets, the same order, each used once. Only
 * durations, source in/out, continuation boundaries and playback rate move.
 */

export interface StripAsset {
  assetId: string;
  sourceDurationS: number;
  description?: string;
  pageUrl?: string | null;
}

export interface StripBeat {
  beat: number;
  durationS: number;
  narration: string;
  hasCard?: boolean;
  cardSecondsS?: number;
  cardText?: string | null;
  /** Carried through untouched for provenance. */
  meta?: Record<string, unknown>;
}

/** Longest a single clip may hold the screen, matching assembly's own cap. */
export const MAX_CLIP_S = BEAT_MAX_S;

export function solveApprovedStrip(assets: StripAsset[], beats: StripBeat[]): ApprovedBeat[] {
  if (assets.length === 0) throw new AllocationConflictError("no approved assets supplied");
  if (beats.length === 0) throw new AllocationConflictError("no beats supplied");

  const capacity = beats.map((b) => {
    const card = b.hasCard ? (b.cardSecondsS ?? 0) : 0;
    const c = +(b.durationS - card).toFixed(6);
    if (c < MIN_FRAGMENT_S) {
      throw new AllocationConflictError(
        `beat ${b.beat}: only ${c.toFixed(2)}s left for footage after a ${card}s card`,
      );
    }
    return c;
  });
  const T = capacity.reduce((a, c) => a + c, 0);

  // Screen time proportional to source length, water-filled against the
  // per-clip ceiling so one long source cannot dominate the video.
  const cap = assets.map((a) => Math.min(a.sourceDurationS, MAX_CLIP_S));
  const capTotal = cap.reduce((a, c) => a + c, 0);
  if (capTotal < T - 1e-6) {
    throw new AllocationConflictError(
      `approved clips provide at most ${capTotal.toFixed(2)}s within the ${MAX_CLIP_S}s clip cap, but ${T.toFixed(2)}s is needed`,
    );
  }
  if (assets.length * MIN_FRAGMENT_S > T + 1e-6) {
    throw new AllocationConflictError(
      `${assets.length} clips cannot each clear the ${MIN_FRAGMENT_S}s floor within ${T.toFixed(2)}s`,
    );
  }

  const budget = new Array(assets.length).fill(0);
  const capped = new Array(assets.length).fill(false);
  for (let pass = 0; pass <= assets.length; pass++) {
    const freeSrc = assets.reduce((a, x, i) => a + (capped[i] ? 0 : x.sourceDurationS), 0);
    const fixed = budget.reduce((a, d, i) => a + (capped[i] ? d : 0), 0);
    const rest = T - fixed;
    if (freeSrc <= 0) break;
    let changed = false;
    for (let i = 0; i < assets.length; i++) {
      if (capped[i]) continue;
      const want = (rest * assets[i]!.sourceDurationS) / freeSrc;
      if (want > cap[i]! + 1e-9) { budget[i] = cap[i]!; capped[i] = true; changed = true; }
      else budget[i] = want;
    }
    if (!changed) break;
  }

  // Boundaries along the strip.
  const aEdge = [0]; for (const d of budget) aEdge.push(aEdge[aEdge.length - 1]! + d);
  const bEdge = [0]; for (const c of capacity) bEdge.push(bEdge[bEdge.length - 1]! + c);

  // A clip must not run across a card, which interrupts the picture, and must
  // not leave a sliver under the floor on either side of a boundary. Snap the
  // offending clip boundary onto the beat boundary; nothing else moves.
  for (let b = 1; b < beats.length; b++) {
    const cutAt = bEdge[b]!;
    const k = aEdge.findIndex((e, i) => i > 0 && e > cutAt + 1e-9 && aEdge[i - 1]! < cutAt - 1e-9);
    if (k === -1) continue;
    const left = cutAt - aEdge[k - 1]!, right = aEdge[k]! - cutAt;
    const overCard = !!beats[b]!.hasCard;
    if (!(overCard || left < MIN_FRAGMENT_S || right < MIN_FRAGMENT_S)) continue;
    const fits = (i: number, at: number) => {
      const lo = aEdge[i - 1]!, hi = aEdge[i + 1]!;
      return at - lo >= MIN_FRAGMENT_S - 1e-9 && at - lo <= assets[i - 1]!.sourceDurationS + 1e-9
        && hi - at >= MIN_FRAGMENT_S - 1e-9 && hi - at <= assets[i]!.sourceDurationS + 1e-9;
    };
    const endMove = fits(k, cutAt) ? Math.abs(aEdge[k]! - cutAt) : Infinity;
    const startMove = k >= 2 && fits(k - 1, cutAt) ? Math.abs(aEdge[k - 1]! - cutAt) : Infinity;
    if (endMove === Infinity && startMove === Infinity) {
      if (overCard) {
        throw new AllocationConflictError(`beat ${beats[b]!.beat}: cannot keep a clip from running across the card`);
      }
      continue;
    }
    if (endMove <= startMove) aEdge[k] = cutAt; else aEdge[k - 1] = cutAt;
  }

  // Which beat each clip starts in, and how far past it runs.
  const out: ApprovedBeat[] = beats.map((b) => ({
    beat: b.beat, durationS: b.durationS, narration: b.narration, fragments: [],
    ...(b.hasCard ? { hasCard: true, cardSecondsS: b.cardSecondsS, cardText: b.cardText ?? null } : {}),
  }));
  // A clip ending exactly on a beat boundary does NOT continue into the next
  // beat. Without a real tolerance here, floating point makes it "continue"
  // for zero seconds, which records a continuation that does not exist.
  const EPS = 1e-3;
  const beatOf = (t: number) => {
    for (let i = 0; i < beats.length; i++) if (t < bEdge[i + 1]! - EPS) return i;
    return beats.length - 1;
  };

  for (let k = 0; k < assets.length; k++) {
    const s0 = aEdge[k]!, s1 = aEdge[k + 1]!;
    const screen = +(s1 - s0).toFixed(6);
    if (screen < MIN_FRAGMENT_S - 1e-6) {
      throw new AllocationConflictError(
        `approved clip ${assets[k]!.assetId} would show for ${screen.toFixed(3)}s, below the ${MIN_FRAGMENT_S}s floor`,
      );
    }
    const src = assets[k]!.sourceDurationS;
    // Prefer 1.0. Only when the source is shorter than the screen time does
    // the clip stretch, and never past the authorised range.
    let rate = src >= screen ? 1 : +(src / screen).toFixed(6);
    if (rate < MIN_PLAYBACK_RATE - 1e-9) {
      throw new AllocationConflictError(
        `approved clip ${assets[k]!.assetId}: ${src}s of source cannot cover ${screen.toFixed(3)}s ` +
        `(would need ${rate.toFixed(4)}x, below ${MIN_PLAYBACK_RATE}x)`,
      );
    }
    if (rate > MAX_PLAYBACK_RATE + 1e-9) rate = MAX_PLAYBACK_RATE;

    const startBeat = beatOf(s0);
    const endBeat = beatOf(Math.max(s0, s1 - EPS));
    const frag: ApprovedFragment = {
      assetId: assets[k]!.assetId,
      plannedDurationS: screen,
      sourceDurationS: src,
      playbackRate: rate,
      description: assets[k]!.description,
      pageUrl: assets[k]!.pageUrl ?? null,
    };
    const carryOut = +(s1 - bEdge[startBeat + 1]!).toFixed(6);
    if (endBeat > startBeat && carryOut > EPS) {
      frag.continuesIntoBeat = beats[startBeat + 1]!.beat;
      frag.continuationSeconds = carryOut;
    }
    out[startBeat]!.fragments.push(frag);
    // Every beat this clip genuinely runs through records what it carries in.
    for (let b = startBeat + 1; b <= endBeat; b++) {
      const seconds = +(Math.min(s1, bEdge[b + 1]!) - bEdge[b]!).toFixed(6);
      if (seconds > EPS) {
        out[b]!.continuedFrom = { assetId: assets[k]!.assetId, fromBeat: beats[b - 1]!.beat, seconds };
      }
    }
  }

  // Fail closed: the strip must cover every beat exactly.
  out.forEach((b, i) => {
    const own = b.fragments.reduce((a, f) => a + f.plannedDurationS - (f.continuationSeconds ?? 0), 0);
    const carried = b.continuedFrom?.seconds ?? 0;
    const covered = own + carried + (b.cardSecondsS ?? 0);
    if (Math.abs(covered - b.durationS) > 0.05) {
      throw new AllocationConflictError(
        `beat ${b.beat}: covered ${covered.toFixed(3)}s of ${b.durationS.toFixed(3)}s`,
      );
    }
    void i;
  });
  const used = out.flatMap((b) => b.fragments.map((f) => f.assetId));
  if (used.length !== assets.length || used.some((id, i) => id !== assets[i]!.assetId)) {
    throw new AllocationConflictError(
      `strip used ${used.length} clips in a different order than the approved ${assets.length}`,
    );
  }
  return out;
}
