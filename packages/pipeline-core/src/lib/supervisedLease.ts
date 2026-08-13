import type { ChannelKey } from "./runtimeTargets";

/**
 * A durable, expiring lease proving a supervised run is still supervised.
 *
 * The incident this exists for: `ai-doom-pilot-control --run` removes the
 * `auth_check` lock, then relies on its own `try/finally` to put it back.
 * `finally` survives exceptions. It does not survive the process being killed.
 * On 2026-08-13 the controller was killed between those two steps, Railway was
 * left at `PIPELINE_MODE=production` with `DISABLE_ELEVEN=false`, and the
 * container went on to buy 5,683 characters of narration with nobody watching.
 *
 * The lesson is not "add another finally". It is that safety must not depend on
 * a particular process continuing to exist. So authority becomes a durable row
 * that must be actively kept alive:
 *
 *   - the controller OPENS a lease before it unlocks anything
 *   - it RENEWS the lease while it watches the run
 *   - it CLOSES the lease when the run ends, in a finally
 *   - every expensive action re-checks the lease before acting
 *
 * A killed controller stops renewing. Within `STALE_AFTER_MS` the lease is
 * stale, and the pipeline refuses to spend, refuses to upload, and refuses to
 * start at all. The Railway variables may still say `production` — that is now
 * cosmetic, because the variable alone authorises nothing.
 *
 * This matters because the monitors hold no `RAILWAY_TOKEN` and therefore
 * cannot relock the environment from outside. A design whose safety depended
 * on a watchdog rewriting Railway variables could not have been implemented
 * here at all. Making the durable lease authoritative, rather than the
 * variable, is what makes the guarantee reachable.
 *
 * Everything below is pure. No database, no clock, no environment — the caller
 * supplies `now` and the row. That is what lets the whole state machine,
 * including every crash transition, be tested deterministically.
 */

export type SupervisedLeaseStatus = "ACTIVE" | "CLOSED" | "EXPIRED";

export interface SupervisedLeaseRow {
  id: string;
  channel: string;
  pilotId: string;
  /** Identifies the one controller invocation that owns this lease. */
  controllerToken: string;
  /** Bound once known, so a lease cannot be reused for a different candidate. */
  videoId: string | null;
  runId: string | null;
  status: SupervisedLeaseStatus;
  openedAt: Date;
  /** Last controller renewal. Absence of renewal is how death is detected. */
  heartbeatAt: Date;
  /** Hard ceiling. Renewal can never push authority past this. */
  expiresAt: Date;
  closedAt: Date | null;
  closedReason: string | null;
}

/**
 * How long a lease may live in total, however often it is renewed.
 *
 * The pipeline force-exits at 30 minutes (`PIPELINE_HARD_TIMEOUT_MS`) and the
 * longest successful AI Doom run ever observed is 9.2 minutes, so 45 minutes is
 * the hard timeout plus half again — the same reasoning already used for the
 * stale-cycle threshold. It is a ceiling, not a target: the normal path closes
 * the lease the moment the run ends.
 */
export const LEASE_MAX_LIFETIME_MS = 45 * 60 * 1000;

/**
 * How long a lease survives without a renewal.
 *
 * The controller already polls the run every 15 seconds, so renewals are free
 * and 90 seconds is six missed beats — long enough that a slow Railway call or
 * a paused process is not mistaken for death, short enough that a killed
 * controller stops authorising spend inside two minutes.
 */
export const LEASE_STALE_AFTER_MS = 90 * 1000;

/** Renewal cadence the controller should use. */
export const LEASE_HEARTBEAT_MS = 15 * 1000;

export interface LeaseCheckInput {
  lease: SupervisedLeaseRow | null;
  now: Date;
  /** The channel asking. A lease never authorises another channel. */
  channel: ChannelKey;
  /** Optional narrowing: the pilot this action belongs to. */
  pilotId?: string;
  /** Optional narrowing: the candidate this action belongs to. */
  videoId?: string;
}

export type LeaseVerdict =
  | { live: true; lease: SupervisedLeaseRow }
  | { live: false; reason: string };

/**
 * Is there live supervision right now, for THIS channel and candidate?
 *
 * Refuses by default. Every branch below is a state in which continuing would
 * mean spending or publishing with nobody watching.
 */
export function checkSupervisedLease(input: LeaseCheckInput): LeaseVerdict {
  const { lease, now, channel, pilotId, videoId } = input;

  if (!lease) return { live: false, reason: "no supervised lease exists" };
  if (lease.status !== "ACTIVE") {
    return { live: false, reason: `lease ${lease.id} is ${lease.status}, not ACTIVE` };
  }
  if (lease.channel !== channel) {
    return { live: false, reason: `lease ${lease.id} belongs to ${lease.channel}, not ${channel}` };
  }
  if (pilotId && lease.pilotId !== pilotId) {
    return { live: false, reason: `lease ${lease.id} belongs to pilot ${lease.pilotId}, not ${pilotId}` };
  }
  // Bound only once the candidate is known. An unbound lease may still be
  // adopted by the first candidate; a bound one may never be reused by another.
  if (videoId && lease.videoId && lease.videoId !== videoId) {
    return { live: false, reason: `lease ${lease.id} is bound to candidate ${lease.videoId}, not ${videoId}` };
  }
  if (now.getTime() >= lease.expiresAt.getTime()) {
    return { live: false, reason: `lease ${lease.id} expired at ${lease.expiresAt.toISOString()}` };
  }
  const sinceBeat = now.getTime() - lease.heartbeatAt.getTime();
  if (sinceBeat > LEASE_STALE_AFTER_MS) {
    return {
      live: false,
      reason: `lease ${lease.id} last renewed ${Math.round(sinceBeat / 1000)}s ago ` +
        `(stale after ${LEASE_STALE_AFTER_MS / 1000}s) — the controller is gone`,
    };
  }
  return { live: true, lease };
}

/** Convenience for call sites that only care whether they may proceed. */
export function leaseIsLive(input: LeaseCheckInput): boolean {
  return checkSupervisedLease(input).live;
}

/**
 * What a renewal is allowed to do.
 *
 * Renewal moves the heartbeat and nothing else. It may not extend `expiresAt`,
 * revive a closed lease, or be performed by anyone but the controller that
 * opened it — otherwise "renew" would quietly become "mint new authority",
 * which is the failure this whole mechanism exists to prevent.
 */
export function canRenew(
  lease: SupervisedLeaseRow | null,
  controllerToken: string,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (!lease) return { ok: false, reason: "no lease to renew" };
  if (lease.status !== "ACTIVE") return { ok: false, reason: `lease is ${lease.status}` };
  if (lease.controllerToken !== controllerToken) {
    return { ok: false, reason: "renewal token does not match the lease owner" };
  }
  if (now.getTime() >= lease.expiresAt.getTime()) {
    return { ok: false, reason: "lease has passed its hard expiry and cannot be renewed" };
  }
  return { ok: true };
}

/**
 * Leases a reconciler should close, and why.
 *
 * Deliberately a pure function over rows so the reconciler is idempotent by
 * construction: running it twice, or running two of them at once, can only
 * ever move the same rows to the same terminal state.
 */
export function leasesNeedingRecovery(
  leases: SupervisedLeaseRow[],
  now: Date,
): { lease: SupervisedLeaseRow; reason: string }[] {
  const out: { lease: SupervisedLeaseRow; reason: string }[] = [];
  for (const lease of leases) {
    if (lease.status !== "ACTIVE") continue;
    if (now.getTime() >= lease.expiresAt.getTime()) {
      out.push({ lease, reason: `expired at ${lease.expiresAt.toISOString()}` });
      continue;
    }
    const sinceBeat = now.getTime() - lease.heartbeatAt.getTime();
    if (sinceBeat > LEASE_STALE_AFTER_MS) {
      out.push({ lease, reason: `abandoned — last renewed ${Math.round(sinceBeat / 1000)}s ago` });
    }
  }
  return out;
}

/**
 * The safe resting configuration.
 *
 * Used to describe what the environment SHOULD look like when no lease is
 * live, so a reconciler and an operator agree on the target without either
 * inventing it.
 */
export const SAFE_RESTING_STATE = {
  PIPELINE_MODE: "auth_check",
  DISABLE_ELEVEN: "true",
} as const;

/**
 * Does the environment claim more capability than the lease state justifies?
 *
 * Split-brain counts: `PIPELINE_MODE=production` with narration disabled is
 * still production-capable and still wrong without a lease, and narration
 * enabled while locked is a staged spend nobody is watching.
 */
export function environmentNeedsRelock(
  vars: { PIPELINE_MODE?: string; DISABLE_ELEVEN?: string },
  hasLiveLease: boolean,
): { needed: boolean; reason: string } {
  const productionCapable = vars.PIPELINE_MODE !== SAFE_RESTING_STATE.PIPELINE_MODE;
  const spendCapable = vars.DISABLE_ELEVEN !== SAFE_RESTING_STATE.DISABLE_ELEVEN;
  if (!productionCapable && !spendCapable) return { needed: false, reason: "already at rest" };
  if (hasLiveLease) return { needed: false, reason: "a live supervised lease authorises this" };
  const what = [
    productionCapable ? `PIPELINE_MODE=${vars.PIPELINE_MODE ?? "<unset>"}` : null,
    spendCapable ? `DISABLE_ELEVEN=${vars.DISABLE_ELEVEN ?? "<unset>"}` : null,
  ].filter(Boolean).join(" ");
  return { needed: true, reason: `${what} with no live supervised lease` };
}
