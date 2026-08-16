import type { ChannelKey } from "./runtimeTargets";

/**
 * Finite, expiring authorization for ordinary production spend.
 *
 * Qualification answered "can this channel make an acceptable video?". It said
 * yes, and the pilot closed. What it deliberately did NOT do is hand the
 * channel a chequebook: `authorizeNarrationWindow` requires a named ACTIVE
 * pilot, so a graduated channel could reach the voiceover stage and buy
 * nothing. That is correct behaviour, and the fix is not to relax it — it is
 * to give ordinary production its own bounded authority.
 *
 * The property worth keeping from the whole qualification effort is this:
 *
 *   Nothing spends because production is "enabled". It spends because durable
 *   state says how many attempts were authorized, by whom, and until when.
 *
 * So there is no PRODUCTION_AUTHORIZED variable, no standing character pool and
 * no permanent budget. There is a row with a count and an expiry. When the
 * count is consumed or the clock passes, the channel is financially inert again
 * without anyone having to remember to turn it off.
 *
 * ATTEMPTS, NOT SUCCESSES. A candidate that fails quality, fails feasibility,
 * or dies before narration still consumes its slot. Free retries would make the
 * count a lower bound rather than a bound: a channel that fails nine times and
 * succeeds once would have run ten candidates under an authorization for one.
 * If a failure deserves another attempt, that is a human authorizing another
 * tranche, which is exactly the review point we want.
 *
 * Everything here is pure. The caller supplies the rows and the clock.
 */

export type ProductionTrancheStatus = "ACTIVE" | "EXHAUSTED" | "EXPIRED" | "CLOSED";
export type TrancheSlotStatus =
  | "CLAIMED" | "SETTLED_SUCCESS" | "SETTLED_FAILED" | "RECONCILIATION_REQUIRED" | "RELEASED";

export interface ProductionTrancheRow {
  id: string;
  channel: string;
  maxCandidates: number;
  consumedCandidates: number;
  releasedCandidates: number;
  status: ProductionTrancheStatus;
  shortsEnabled: boolean;
  authorizedBy: string;
  policyCommit: string | null;
  authorizedAt: Date;
  expiresAt: Date;
  closedAt: Date | null;
  closedReason: string | null;
}

export interface ProductionTrancheSlotRow {
  id: string;
  trancheId: string;
  channel: string;
  slotIndex: number;
  status: TrancheSlotStatus;
  videoId: string;
  runId: string;
  claimedAt: Date;
  settledAt: Date | null;
  outcome: string | null;
}

/**
 * How long an authorization may live.
 *
 * Ordinary production publishes on a M/W/F cadence, so a tranche that outlived
 * a full week would let a forgotten authorization fire against a completely
 * different editorial context. Seven days is the outer bound; the practical
 * default is far shorter because a tranche is meant to be run and closed, not
 * kept around.
 */
export const TRANCHE_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const TRANCHE_DEFAULT_LIFETIME_MS = 48 * 60 * 60 * 1000;

/**
 * The largest tranche anyone may authorize in one command.
 *
 * Not a safety boundary on its own — the expiry and the per-candidate ceiling
 * are — but a typo bound. "--count 100" should be refused as obviously wrong
 * rather than accepted because the field is an integer.
 */
export const TRANCHE_MAX_CANDIDATES = 10;

export type AuthorizeVerdict =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: string };

export interface AuthorizeRequest {
  channel: ChannelKey;
  count: number;
  /** Channel must already have completed its pilot. Graduation is a precondition. */
  graduated: boolean;
  /** Any tranche already live for this channel. Two would be two chequebooks. */
  existing: ProductionTrancheRow | null;
  lifetimeMs?: number;
  now: Date;
}

/**
 * May a human create this authorization?
 *
 * Refuses by default. Creating a tranche spends nothing and starts nothing, but
 * it is the only thing that makes spending possible later, so it is guarded
 * like the spend itself.
 */
export function canAuthorizeTranche(req: AuthorizeRequest): AuthorizeVerdict {
  if (!req.graduated) {
    return { ok: false, reason: `${req.channel} has not completed its qualification pilot` };
  }
  if (!Number.isInteger(req.count)) {
    return { ok: false, reason: `count ${req.count} is not an integer` };
  }
  if (req.count < 1) {
    return { ok: false, reason: `count ${req.count} must authorize at least one candidate` };
  }
  if (req.count > TRANCHE_MAX_CANDIDATES) {
    return {
      ok: false,
      reason: `count ${req.count} exceeds the maximum ${TRANCHE_MAX_CANDIDATES} per tranche`,
    };
  }
  const lifetime = req.lifetimeMs ?? TRANCHE_DEFAULT_LIFETIME_MS;
  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    return { ok: false, reason: `lifetime ${lifetime}ms is not a positive finite duration` };
  }
  if (lifetime > TRANCHE_MAX_LIFETIME_MS) {
    return {
      ok: false,
      reason: `lifetime ${Math.round(lifetime / 3600_000)}h exceeds the maximum ` +
        `${TRANCHE_MAX_LIFETIME_MS / 3600_000}h`,
    };
  }
  if (req.existing && liveTranche(req.existing, req.now).live) {
    return {
      ok: false,
      reason: `tranche ${req.existing.id} is still live for ${req.channel} ` +
        `(${remainingCandidates(req.existing)} of ${req.existing.maxCandidates} remaining) — ` +
        "close it before authorizing another",
    };
  }
  return { ok: true, expiresAt: new Date(req.now.getTime() + lifetime) };
}

/**
 * Attempts still available.
 *
 * `consumedCandidates` is monotonic — it is never decremented, so `slotIndex`
 * stays unique — and a release is recorded separately. Effective consumption is
 * the difference, which keeps a released attempt visibly distinct from one that
 * was never used.
 */
export function remainingCandidates(t: ProductionTrancheRow): number {
  return Math.max(0, t.maxCandidates - (t.consumedCandidates - (t.releasedCandidates ?? 0)));
}

/**
 * How many attempts one tranche may reclaim.
 *
 * A release costs a model call and nothing else, so refusing them outright
 * would burn authorised work on defects the pipeline detected itself. But an
 * unbounded release turns a finite tranche into an unbounded one: a channel
 * that fails deterministically forever would retry forever. Two is enough to
 * absorb the occasional bad draw and small enough that a systematic fault still
 * exhausts the tranche and stops.
 */
export const MAX_RELEASES_PER_TRANCHE = 2;

export type ReleaseVerdict =
  | { ok: true }
  | { ok: false; capHit: boolean; reason: string };

/**
 * May this consumed attempt be given back?
 *
 * Pure, and refuses by default. Every condition is durable evidence that the
 * candidate stopped before anything irreversible: nothing was charged, no
 * upload was attempted, no render exists. A release is not a retry — the
 * candidate is still terminally failed; only the capacity returns.
 */
export function canReleaseAttempt(input: {
  tranche: ProductionTrancheRow | null;
  slot: ProductionTrancheSlotRow | null;
  classificationIsPreSpend: boolean;
  chargedChars: number;
  uploadIntents: number;
  hasRenderArtifact: boolean;
}): ReleaseVerdict {
  const { tranche, slot } = input;
  if (!tranche || !slot) return { ok: false, capHit: false, reason: "no tranche slot for this candidate" };
  if (slot.status === "RELEASED") {
    return { ok: false, capHit: false, reason: "already released" };
  }
  if (!input.classificationIsPreSpend) {
    return { ok: false, capHit: false, reason: "classification is not a deterministic pre-spend failure" };
  }
  if (input.chargedChars !== 0) {
    return { ok: false, capHit: false, reason: `${input.chargedChars} narration char(s) charged for this run` };
  }
  if (input.uploadIntents !== 0) {
    return { ok: false, capHit: false, reason: `${input.uploadIntents} upload intent(s) exist for this run` };
  }
  if (input.hasRenderArtifact) {
    return { ok: false, capHit: false, reason: "a render artifact exists" };
  }
  if ((tranche.releasedCandidates ?? 0) >= MAX_RELEASES_PER_TRANCHE) {
    return {
      ok: false, capHit: true,
      reason: `${tranche.releasedCandidates} release(s) already used, cap is ${MAX_RELEASES_PER_TRANCHE} ` +
        "— the attempt stays consumed",
    };
  }
  return { ok: true };
}

export type LiveVerdict =
  | { live: true; remaining: number }
  | { live: false; reason: string };

/** Is this authorization still capable of authorizing another candidate? */
export function liveTranche(
  t: ProductionTrancheRow | null, now: Date,
): LiveVerdict {
  if (!t) return { live: false, reason: "no production tranche exists" };
  if (t.status !== "ACTIVE") {
    return { live: false, reason: `tranche ${t.id} is ${t.status}, not ACTIVE` };
  }
  if (now.getTime() >= t.expiresAt.getTime()) {
    return {
      live: false,
      reason: `tranche ${t.id} expired at ${t.expiresAt.toISOString()}`,
    };
  }
  const remaining = remainingCandidates(t);
  if (remaining <= 0) {
    return {
      live: false,
      reason: `tranche ${t.id} is exhausted (${t.consumedCandidates}/${t.maxCandidates} consumed)`,
    };
  }
  return { live: true, remaining };
}

export interface ClaimRequest {
  channel: ChannelKey;
  videoId: string;
  runId: string;
  now: Date;
}

export type ClaimVerdict =
  | { ok: true; slotIndex: number }
  | { ok: false; reason: string };

/**
 * May this execution take a slot?
 *
 * The claim is what converts "N attempts are authorized" into "THIS candidate
 * and THIS run hold attempt number k". After it, the slot names one execution
 * and can never name another, which is the property that stops a second
 * candidate proceeding while the first is still running.
 */
export function canClaimSlot(
  t: ProductionTrancheRow | null, req: ClaimRequest,
): ClaimVerdict {
  const live = liveTranche(t, req.now);
  if (!live.live) return { ok: false, reason: live.reason };
  const tranche = t!;
  if (tranche.channel !== req.channel) {
    return {
      ok: false,
      reason: `tranche ${tranche.id} authorizes ${tranche.channel}, not ${req.channel}`,
    };
  }
  if (!req.videoId || !req.runId) {
    return {
      ok: false,
      reason: `a slot needs both a candidate and a run (candidate=${req.videoId || "none"} ` +
        `run=${req.runId || "none"})`,
    };
  }
  return { ok: true, slotIndex: tranche.consumedCandidates };
}

export interface SlotAuthorityRequest {
  channel: ChannelKey;
  videoId: string;
  runId: string;
  now: Date;
}

export type SlotAuthorityVerdict =
  | { authorized: true; slot: ProductionTrancheSlotRow }
  | { authorized: false; reason: string };

/**
 * Does this exact execution hold a usable slot right now?
 *
 * Asked again at the moment of spend, not merely at claim time — a tranche that
 * expired between claiming a slot and reaching the voiceover stage must not pay
 * for narration. This mirrors the supervised lease's re-check for the same
 * reason: authorization is a state, not an event.
 */
export function checkSlotAuthority(
  slot: ProductionTrancheSlotRow | null,
  tranche: ProductionTrancheRow | null,
  req: SlotAuthorityRequest,
): SlotAuthorityVerdict {
  if (!slot) {
    return {
      authorized: false,
      reason: `candidate ${req.videoId} holds no production tranche slot`,
    };
  }
  if (slot.status !== "CLAIMED") {
    return {
      authorized: false,
      reason: `slot ${slot.id} is ${slot.status} — already settled, it authorizes nothing further`,
    };
  }
  if (slot.channel !== req.channel) {
    return { authorized: false, reason: `slot ${slot.id} belongs to ${slot.channel}, not ${req.channel}` };
  }
  if (slot.videoId !== req.videoId) {
    return { authorized: false, reason: `slot ${slot.id} is bound to candidate ${slot.videoId}, not ${req.videoId}` };
  }
  if (slot.runId !== req.runId) {
    return { authorized: false, reason: `slot ${slot.id} is bound to run ${slot.runId}, not ${req.runId}` };
  }
  if (!tranche) {
    return { authorized: false, reason: `slot ${slot.id} has no parent tranche` };
  }
  if (tranche.id !== slot.trancheId) {
    return { authorized: false, reason: `slot ${slot.id} belongs to tranche ${slot.trancheId}, not ${tranche.id}` };
  }
  // Status and expiry are re-read here; capacity deliberately is NOT, because
  // this slot is already counted in consumedCandidates. Requiring remaining > 0
  // would make the last authorized candidate unable to use the slot it holds.
  if (tranche.status !== "ACTIVE" && tranche.status !== "EXHAUSTED") {
    return { authorized: false, reason: `tranche ${tranche.id} is ${tranche.status}` };
  }
  if (req.now.getTime() >= tranche.expiresAt.getTime()) {
    return {
      authorized: false,
      reason: `tranche ${tranche.id} expired at ${tranche.expiresAt.toISOString()} — ` +
        "the authorization ran out before this candidate reached spend",
    };
  }
  return { authorized: true, slot };
}

/**
 * How a finished candidate settles its slot.
 *
 * A slot is never returned to the pool. Settling records what happened so an
 * operator can read the history, and moves the slot out of CLAIMED so nothing
 * mistakes it for live authority.
 *
 * Ambiguity settles to RECONCILIATION_REQUIRED rather than either terminal
 * state: "we do not know whether this uploaded" must never quietly become
 * "capacity is free again".
 */
export function settlementFor(
  outcome: "SUCCESS" | "FAILED" | "AMBIGUOUS",
): TrancheSlotStatus {
  if (outcome === "SUCCESS") return "SETTLED_SUCCESS";
  if (outcome === "FAILED") return "SETTLED_FAILED";
  return "RECONCILIATION_REQUIRED";
}

export type TranchePhase =
  | "NO_AUTHORIZATION"
  | "AUTHORIZED"
  | "SLOT_IN_FLIGHT"
  | "EXHAUSTED"
  | "EXPIRED"
  | "RECONCILIATION_REQUIRED"
  | "CLOSED";

/**
 * One word an operator can act on.
 *
 * NO_AUTHORIZATION is the normal resting state and is not an error: a system
 * with no live tranche is a system that cannot spend, which is where it should
 * sit between tranches.
 */
export function classifyTranchePhase(
  t: ProductionTrancheRow | null,
  slots: ProductionTrancheSlotRow[],
  now: Date,
): TranchePhase {
  if (!t) return "NO_AUTHORIZATION";
  if (slots.some((s) => s.status === "RECONCILIATION_REQUIRED")) return "RECONCILIATION_REQUIRED";
  if (t.status === "CLOSED") return "CLOSED";
  if (t.status === "EXPIRED" || now.getTime() >= t.expiresAt.getTime()) return "EXPIRED";
  if (slots.some((s) => s.status === "CLAIMED")) return "SLOT_IN_FLIGHT";
  if (t.status === "EXHAUSTED" || remainingCandidates(t) <= 0) return "EXHAUSTED";
  return "AUTHORIZED";
}

/**
 * Tranches a reconciler should retire, and why.
 *
 * Pure over rows so running it twice, or two at once, can only move the same
 * rows to the same terminal state. It never increases capacity — the only
 * transitions available are ACTIVE → EXPIRED and ACTIVE → EXHAUSTED.
 */
export function tranchesNeedingRecovery(
  tranches: ProductionTrancheRow[],
  now: Date,
): { tranche: ProductionTrancheRow; status: "EXPIRED" | "EXHAUSTED"; reason: string }[] {
  const out: { tranche: ProductionTrancheRow; status: "EXPIRED" | "EXHAUSTED"; reason: string }[] = [];
  for (const t of tranches) {
    if (t.status !== "ACTIVE") continue;
    if (now.getTime() >= t.expiresAt.getTime()) {
      out.push({ tranche: t, status: "EXPIRED", reason: `expired at ${t.expiresAt.toISOString()}` });
      continue;
    }
    if (remainingCandidates(t) <= 0) {
      out.push({
        tranche: t, status: "EXHAUSTED",
        reason: `all ${t.maxCandidates} authorized candidate(s) consumed`,
      });
    }
  }
  return out;
}
