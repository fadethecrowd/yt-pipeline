import { prisma } from "./db";
import type { ProductionCycle } from "./productionCycle";
import {
  currentRunnableCycle, claimCycle, completeCycle, failCycle,
} from "./productionCycle";
import { CLAIM_STALE_AFTER_MS } from "./runtimeLimits";

export { CLAIM_STALE_AFTER_MS };

/**
 * The gate an unattended container passes through before it may do any work.
 *
 * A container start is not an authorization. Ordinary production may happen
 * only when BOTH are true: the runtime is explicitly in unattended mode, and a
 * durable ProductionCycle says a video is owed. Anything else exits before
 * resume, before discovery, and therefore before any candidate, reservation,
 * render or upload.
 *
 * `PIPELINE_MODE=auth_check` remains the global maintenance lock and is checked
 * earlier, in each channel's index.ts. This gate sits strictly inside the
 * advisory lock and strictly before the resume query.
 */

/** The explicit runtime mode that permits unattended ordinary production. */
export const UNATTENDED_MODE = "unattended";

export type GateDecision =
  | { run: false; reason: string; cycle: null }
  | { run: true; reason: string; cycle: ProductionCycle };

/**
 * Whether this process is configured for unattended production.
 *
 * Fail-closed and exact: only the literal string enables it. Absence, a typo,
 * or any other value means "not unattended", which means no work.
 */
export function isUnattendedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PRODUCTION_MODE ?? "").trim() === UNATTENDED_MODE;
}

/**
 * A STABLE claimant identity, deliberately not a per-process UUID.
 *
 * This is the correction to an actual defect. `claimCycle` guards on
 * `claimantId IS NULL OR claimantId = $2`, so if the claimant were a random
 * value minted at startup, a container that crashed mid-cycle could never
 * resume: the restarted process would present a different id, match nothing,
 * and leave the cycle stranded in CLAIMED forever. "The same claimant may
 * re-claim" is only true if the identity actually survives the crash.
 *
 * It is safe for this to be shared across restarts of the same channel because
 * mutual exclusion does NOT come from the claimant string. It comes from the
 * Postgres advisory lock that already wraps runPipeline in both channels:
 * `pg_try_advisory_lock` is session-scoped, so a second live container is
 * refused outright, and a crashed container's lock is released with its
 * connection — which is exactly what makes the restart legitimate.
 *
 * So the two requirements are met by two different mechanisms, each doing the
 * job it is actually good at: the advisory lock excludes concurrent runners,
 * and the stable identity distinguishes *which kind of runner* owns a cycle so
 * that, say, the manual control cannot silently adopt an unattended one.
 */
export function unattendedClaimantId(channel: string): string {
  return `unattended:${channel}`;
}

/**
 * Whether a claim is old enough that no live process can still hold it.
 *
 * Age alone is never sufficient to release a claim — see `failAbandonedCycle`,
 * which also requires the channel advisory lock. This answers only "is it worth
 * a human looking at this".
 */
export function isClaimStale(cycle: ProductionCycle, now = new Date()): boolean {
  if (cycle.status !== "CLAIMED" || !cycle.claimedAt) return false;
  return now.getTime() - new Date(cycle.claimedAt).getTime() > CLAIM_STALE_AFTER_MS;
}

/**
 * Decide whether this container may run, and claim the cycle if so.
 *
 * Must be called inside the advisory lock and before the resume query. Returns
 * `run: false` for every ordinary case — no unattended mode, no authorized
 * cycle, or a cycle another claimant holds — and the caller must then return
 * without touching a candidate.
 */
export async function openUnattendedGate(
  channel: string, now = new Date(), env: NodeJS.ProcessEnv = process.env,
): Promise<GateDecision> {
  if (!isUnattendedMode(env)) {
    return { run: false, cycle: null,
      reason: `PRODUCTION_MODE is not "${UNATTENDED_MODE}" — unattended production not enabled` };
  }

  const cycle = await currentRunnableCycle(channel, now);
  if (!cycle) {
    return { run: false, cycle: null,
      reason: "no runnable production cycle — no video is owed" };
  }

  const claimant = unattendedClaimantId(channel);
  const claimed = await claimCycle(cycle.id, claimant);
  if (!claimed) {
    // Another claimant holds it. Never steal: a manual run or a foreign
    // claimant owning this cycle is a state a human should look at.
    return { run: false, cycle: null,
      reason: `cycle ${cycle.id} is held by ${cycle.claimantId ?? "another claimant"} — refusing to steal` };
  }

  return { run: true, cycle: claimed,
    reason: claimed.videoId
      ? `resuming cycle ${claimed.id} candidate ${claimed.videoId}`
      : `claimed cycle ${claimed.id} for slot ${claimed.targetPublishSlot.toISOString()}` };
}

/**
 * Create the cycle's ONE candidate and bind it, atomically.
 *
 * The dangerous window is between creating a candidate row and recording it on
 * the cycle: a crash in that gap leaves an orphan candidate and a cycle that
 * still looks entitled to create one, which is how a single authorization turns
 * into two videos. Both statements therefore run in one transaction — either
 * the candidate exists AND the cycle owns it, or neither happened.
 *
 * The attach is itself a compare-and-set on `videoId IS NULL`, so even if two
 * transactions somehow reached this point, the loser's attach affects zero rows
 * and its whole transaction is rolled back, taking its candidate with it.
 *
 * `createCandidate` receives the transaction client and must use it for the
 * insert; anything it does outside that client is not covered.
 */
export async function createAndAttachCandidate(
  cycleId: string,
  claimantId: string,
  createCandidate: (tx: unknown) => Promise<{ id: string }>,
  pipelineRunId?: string,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const candidate = await createCandidate(tx);
    const affected = await (tx as unknown as {
      $executeRawUnsafe(q: string, ...a: unknown[]): Promise<number>;
    }).$executeRawUnsafe(
      `UPDATE "production_cycle"
          SET "videoId" = $3, "pipelineRunId" = COALESCE($4, "pipelineRunId"), "updatedAt" = NOW()
        WHERE "id" = $1 AND "claimantId" = $2
          AND "status" = 'CLAIMED' AND "videoId" IS NULL`,
      cycleId, claimantId, candidate.id, pipelineRunId ?? null,
    );
    if (affected !== 1) {
      // Rolls back the candidate too — this is the whole point.
      throw new Error(
        `cycle ${cycleId} already carries a candidate (attach matched ${affected} rows) — ` +
        "refusing to create a second",
      );
    }
    return candidate;
  });
}

/**
 * Stages whose failure leaves the outside world in an unknown state.
 *
 * A thrown upload is not evidence that nothing was uploaded — the request may
 * have reached YouTube and the acknowledgement may have been what was lost. So
 * a failure here is not a failure to retry; it parks the cycle in
 * RECONCILIATION_REQUIRED, which `currentRunnableCycle` never returns, and a
 * human confirms what actually exists on the channel before anything resumes.
 */
export const AMBIGUOUS_STAGES = new Set(["youtubeUpload"]);

export function isAmbiguousFailure(stage: string): boolean {
  return AMBIGUOUS_STAGES.has(stage);
}

/** A cycle this process owns, carried so terminal paths can settle it. */
export interface ActiveCycle {
  id: string;
  claimantId: string;
}

/**
 * Record the cycle's outcome. Best-effort and never throws.
 *
 * A settlement failure must not turn a completed video into a crash, and must
 * not mask the original stage error on the failure path — an unsettled cycle is
 * visible to the control tool, whereas a thrown settlement would lose the real
 * reason the run ended. Both are reported loudly instead.
 */
export async function settleCycle(
  active: ActiveCycle | null,
  outcome: { ok: true } | { ok: false; stage: string; reason: string },
): Promise<void> {
  if (!active) return;
  try {
    if (outcome.ok) {
      const done = await completeCycle(active.id, active.claimantId);
      console.log(done
        ? `[cycle] ${active.id} COMPLETED`
        : `[cycle] ${active.id} could not be completed — inspect with production-cycle-control --check`);
      return;
    }
    const ambiguous = isAmbiguousFailure(outcome.stage);
    const code = `${outcome.stage}: ${outcome.reason}`.slice(0, 500);
    const done = await failCycle(active.id, active.claimantId, code, ambiguous);
    console.log(done
      ? `[cycle] ${active.id} ${ambiguous ? "RECONCILIATION_REQUIRED" : "FAILED"} (${outcome.stage})`
      : `[cycle] ${active.id} could not be failed — inspect with production-cycle-control --check`);
  } catch (err) {
    console.error(`[cycle] settlement error for ${active.id}: ` +
      `${err instanceof Error ? err.message : String(err)}`);
  }
}
