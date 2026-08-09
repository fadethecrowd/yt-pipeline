import type { ProductionCycle } from "./productionCycle";
import { CLAIM_STALE_AFTER_MS } from "./runtimeLimits";
import { MINIMUM_LEAD_MS } from "./authorizationScheduler";

/**
 * Health checks for unattended production.
 *
 * The existing monitor checks (packages/monitor/src/lib/videoHealth.ts) predate
 * ProductionCycle entirely: they watch scheduled videos, upload intents, runs,
 * budgets and pilots, but nothing knows a cycle exists. Once unattended
 * production is enabled that is the largest blind spot in the system — the
 * whole mechanism that decides a video is owed would be unobserved.
 *
 * Pure and read-only, matching the existing checks. Same input, same findings,
 * no database, no clock of its own.
 *
 * DESIGNED STATES NEVER ALERT. A cycle sitting AUTHORIZED hours before its slot
 * is the system working; a cycle CLAIMED for ten minutes is a pipeline running.
 * Alerting on those would bury the findings that matter. Every check below fires
 * only on a state that is either impossible or actionable.
 */

export type CycleSeverity = "WARN" | "ALERT";

export interface CycleFinding {
  code: string;
  severity: CycleSeverity;
  subject: string;
  detail: string;
}

export interface CycleHealthInput {
  channel: string;
  /** Every non-terminal cycle, plus recent terminal ones for reporting. */
  cycles: ProductionCycle[];
  /** Publication slots in the recent past, newest first. */
  recentSlots: Date[];
  /** Videos already scheduled for those slots, by slot instant. */
  scheduledSlotInstants: number[];
  /** Whether the scheduler is armed for this channel. */
  schedulerEnabled: boolean;
  /** Whether the pipeline runtime is in unattended mode. */
  unattendedEnabled: boolean;
  now: Date;
}

/**
 * A. Cycles that should have been picked up and were not.
 *
 * An AUTHORIZED cycle is only a problem once there is no longer time to run it:
 * before that it is simply waiting. The boundary is the scheduler's own minimum
 * lead, which is the point past which a run plus one retry no longer fits.
 */
export function checkUnclaimed(c: ProductionCycle, now: Date): CycleFinding[] {
  if (c.status !== "AUTHORIZED") return [];
  const msToSlot = c.targetPublishSlot.getTime() - now.getTime();
  if (msToSlot > MINIMUM_LEAD_MS) return [];
  if (msToSlot <= 0) {
    return [{ code: "CYCLE_SLOT_PASSED_UNCLAIMED", severity: "ALERT", subject: c.id,
      detail: `authorized for ${c.targetPublishSlot.toISOString()} but never claimed; ` +
        "the slot has passed — no video was produced for it" }];
  }
  return [{ code: "CYCLE_NOT_CLAIMED_IN_TIME", severity: "ALERT", subject: c.id,
    detail: `authorized for ${c.targetPublishSlot.toISOString()}, ` +
      `${Math.round(msToSlot / 60000)}min away and still unclaimed — ` +
      "no container has started; check the pipeline service" }];
}

/** B. A claim nothing can still be holding. */
export function checkStaleClaim(c: ProductionCycle, now: Date): CycleFinding[] {
  if (c.status !== "CLAIMED" || !c.claimedAt) return [];
  const ageMs = now.getTime() - new Date(c.claimedAt).getTime();
  if (ageMs <= CLAIM_STALE_AFTER_MS) return [];
  return [{ code: "CYCLE_CLAIM_STALE", severity: "ALERT", subject: c.id,
    detail: `claimed ${Math.round(ageMs / 60000)}min ago by ${c.claimantId ?? "?"}; ` +
      `threshold ${CLAIM_STALE_AFTER_MS / 60000}min — inspect with ` +
      "production-cycle-control --inspect-stale (never reap without inspecting)" }];
}

/** C. Terminal states a human needs to see. */
export function checkTerminal(c: ProductionCycle): CycleFinding[] {
  if (c.status === "RECONCILIATION_REQUIRED") {
    return [{ code: "CYCLE_RECONCILIATION_REQUIRED", severity: "ALERT", subject: c.id,
      detail: `held for reconciliation (${c.failureCode ?? "no code"}) — ` +
        "a video may exist on the channel that we did not record; never retry" }];
  }
  if (c.status === "FAILED") {
    return [{ code: "CYCLE_FAILED", severity: "WARN", subject: c.id,
      detail: `failed (${c.failureCode ?? "no code"}); nothing reached YouTube — ` +
        "the next slot proceeds normally" }];
  }
  return [];
}

/**
 * D. Linkage that cannot be true.
 *
 * These are not "unlikely", they are contradictions: a cycle that completed
 * without producing anything, or one that carries a candidate while claiming
 * nobody has claimed it.
 */
export function checkLinkage(c: ProductionCycle): CycleFinding[] {
  const out: CycleFinding[] = [];
  if (c.status === "COMPLETED" && !c.videoId) {
    out.push({ code: "CYCLE_COMPLETED_WITHOUT_VIDEO", severity: "ALERT", subject: c.id,
      detail: "COMPLETED but carries no candidate — nothing was produced under this authorization" });
  }
  if (c.status === "AUTHORIZED" && c.videoId) {
    out.push({ code: "CYCLE_UNCLAIMED_WITH_VIDEO", severity: "ALERT", subject: c.id,
      detail: `AUTHORIZED but already bound to ${c.videoId} — claim state was lost` });
  }
  if (c.status === "CLAIMED" && !c.claimantId) {
    out.push({ code: "CYCLE_CLAIMED_WITHOUT_CLAIMANT", severity: "ALERT", subject: c.id,
      detail: "CLAIMED with no claimant — the row cannot be resumed or reaped safely" });
  }
  return out;
}

/**
 * E. More than one open cycle for a channel.
 *
 * The entire design rests on at most one video being owed at a time. Two open
 * cycles means two containers could each find work.
 */
export function checkSingleOpenCycle(
  channel: string, cycles: ProductionCycle[], now: Date,
): CycleFinding[] {
  const open = cycles.filter((c) =>
    (c.status === "AUTHORIZED" || c.status === "CLAIMED") &&
    c.targetPublishSlot.getTime() > now.getTime());
  if (open.length <= 1) return [];
  return [{ code: "CYCLE_MULTIPLE_OPEN", severity: "ALERT", subject: channel,
    detail: `${open.length} open cycles (${open.map((c) => c.id).join(", ")}) — ` +
      "at most one video may ever be owed" }];
}

/**
 * F. A publication slot that came and went with nothing to show for it.
 *
 * Deliberately a WARN, not an ALERT. A missed slot is a gap in output, not a
 * safety incident, and it is the CORRECT outcome of several safe behaviours —
 * the scheduler being intentionally disabled, or a run failing closed. It must
 * be visible without implying something dangerous happened.
 *
 * Only slots that had a cycle, or that fall while the system is armed, count.
 * A slot that passed while unattended production was switched off is not a
 * miss; it is a system that was turned off on purpose.
 */
export function checkMissedSlots(input: CycleHealthInput): CycleFinding[] {
  if (!input.schedulerEnabled || !input.unattendedEnabled) return [];
  const out: CycleFinding[] = [];
  const scheduled = new Set(input.scheduledSlotInstants);
  for (const slot of input.recentSlots) {
    if (slot.getTime() > input.now.getTime()) continue;
    if (scheduled.has(slot.getTime())) continue;
    const cycle = input.cycles.find(
      (c) => c.targetPublishSlot.getTime() === slot.getTime());
    if (cycle?.status === "COMPLETED") continue;
    out.push({ code: "SLOT_MISSED", severity: "WARN", subject: slot.toISOString(),
      detail: cycle
        ? `slot passed with cycle ${cycle.id} in ${cycle.status} — no video published`
        : "slot passed with no cycle ever authorized — the scheduler did not fire" });
  }
  return out;
}

/**
 * G. The two runtime gates disagreeing with each other.
 *
 * Neither combination is dangerous on its own — both gates must be open for
 * anything to happen — but each means the operator's intent and the deployed
 * reality have diverged, and that is worth knowing before a slot arrives.
 */
export function checkGateCoherence(input: CycleHealthInput): CycleFinding[] {
  const { schedulerEnabled, unattendedEnabled, channel } = input;
  if (schedulerEnabled && !unattendedEnabled) {
    return [{ code: "SCHEDULER_ARMED_WITHOUT_RUNTIME", severity: "WARN", subject: channel,
      detail: "the scheduler will authorize cycles that nothing can execute — " +
        "cycles will accumulate as missed slots" }];
  }
  if (!schedulerEnabled && unattendedEnabled) {
    return [{ code: "RUNTIME_ARMED_WITHOUT_SCHEDULER", severity: "WARN", subject: channel,
      detail: "unattended runtime is on but nothing will authorize work — " +
        "container starts will find nothing to do" }];
  }
  return [];
}

export interface CycleHealthReport {
  channel: string;
  findings: CycleFinding[];
  healthy: boolean;
}

/** Whole-channel cycle evaluation. Pure. */
export function evaluateCycleHealth(input: CycleHealthInput): CycleHealthReport {
  const findings: CycleFinding[] = [];
  for (const c of input.cycles) {
    findings.push(...checkUnclaimed(c, input.now));
    findings.push(...checkStaleClaim(c, input.now));
    findings.push(...checkTerminal(c));
    findings.push(...checkLinkage(c));
  }
  findings.push(...checkSingleOpenCycle(input.channel, input.cycles, input.now));
  findings.push(...checkMissedSlots(input));
  findings.push(...checkGateCoherence(input));
  return {
    channel: input.channel,
    findings,
    healthy: findings.every((f) => f.severity !== "ALERT"),
  };
}
