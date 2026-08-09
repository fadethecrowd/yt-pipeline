import { prisma } from "./db";
import type { ProductionCycle } from "./productionCycle";
import { getCycle } from "./productionCycle";
import { isClaimStale } from "./unattendedGate";
import { CLAIM_STALE_AFTER_MS } from "./runtimeLimits";

/**
 * Recovering a cycle whose owning process is gone.
 *
 * The failure this addresses is narrow, and naming it precisely matters because
 * the obvious "fix" is dangerous. A cycle goes CLAIMED, the container dies, and
 * nothing restarts it. The cycle then sits CLAIMED forever.
 *
 * What that does NOT do is block forward progress indefinitely.
 * `currentRunnableCycle` requires `targetPublishSlot > now`, so an abandoned
 * cycle stops being runnable — and stops blocking authorization of the next
 * slot — the moment its own slot passes. The blocking window is bounded by the
 * authorization lead time, not unbounded. Verified against the predicate, not
 * assumed. The residue is a permanently non-terminal row and, if a candidate
 * was attached, a permanently stuck candidate: an operational and reporting
 * problem, not a liveness one.
 *
 * So recovery is about hygiene and clarity, which is why it is allowed to be
 * conservative and explicitly human-invoked rather than automatic.
 *
 * THE RULES, none of which may be relaxed for convenience:
 *
 *   - A stale cycle is NEVER reset to AUTHORIZED. Doing so would re-arm it to
 *     produce a candidate, and a cycle that already made one would then be
 *     entitled to make a second. Recovery only ever moves a cycle to a TERMINAL
 *     state.
 *   - `claimantId` is NEVER cleared. It is evidence of who held the cycle.
 *   - Age NEVER releases a claim by itself. Time proves nothing about whether a
 *     process is alive; the advisory lock does.
 *   - Anything that may have reached YouTube is human-only, forever.
 */

/** The advisory lock each channel's pipeline holds while it runs. */
export const CHANNEL_LOCK_IDS: Record<string, number> = {
  // Mirrors config.PIPELINE_LOCK_ID's default and the deployed value.
  "ai-doom-scroll": 123456,
  // Mirrors WC_LOCK_ID in packages/wc-pipeline/src/pipeline.ts.
  "wet-circuit": 789012,
};

export function channelLockId(channel: string): number {
  const id = CHANNEL_LOCK_IDS[channel];
  if (id === undefined) throw new Error(`no advisory lock id known for channel ${channel}`);
  return id;
}

export type StaleDisposition =
  | "NOT_STALE"
  | "NOT_CLAIMED"
  | "OWNER_ALIVE"
  | "SAFE_TO_FAIL"
  | "NEEDS_RECONCILIATION";

export interface StaleAssessment {
  cycle: ProductionCycle | null;
  disposition: StaleDisposition;
  reasons: string[];
  /** Evidence gathered about the attached candidate, if any. */
  sideEffects: {
    videoId: string | null;
    youtubeId: string | null;
    unresolvedIntents: number;
    narrationCharges: number;
    ownerAlive: boolean | null;
  };
}

const VIDEO_TABLE: Record<string, string> = {
  "ai-doom-scroll": "Video",
  "wet-circuit": "wc_video",
};

/**
 * Can this process take the channel's pipeline lock right now?
 *
 * This is the liveness proof. `pg_try_advisory_lock` is session-scoped: a live
 * pipeline holds it for the duration of its run, and a dead one's lock died
 * with its connection. Acquiring it therefore proves no pipeline session is
 * running for this channel — something no timestamp can establish.
 *
 * The lock is released immediately; callers that intend to mutate must hold it
 * across the mutation instead (see `failAbandonedCycle`).
 */
export async function ownerAppearsGone(channel: string): Promise<boolean> {
  const lockId = channelLockId(channel);
  const [{ acquired }] = await prisma.$queryRawUnsafe<[{ acquired: boolean }]>(
    `SELECT pg_try_advisory_lock($1) AS acquired`, lockId,
  );
  if (acquired) await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, lockId);
  return acquired;
}

/**
 * Read-only assessment. Mutates nothing, ever.
 *
 * Deliberately separate from the operation that acts on it: a check that can
 * quietly change state is a check nobody can safely run.
 */
export async function inspectStaleCycle(
  channel: string, cycleId: string, now = new Date(),
): Promise<StaleAssessment> {
  const cycle = await getCycle(cycleId);
  const sideEffects: StaleAssessment["sideEffects"] = {
    videoId: null, youtubeId: null, unresolvedIntents: 0,
    narrationCharges: 0, ownerAlive: null,
  };
  if (!cycle) {
    return { cycle: null, disposition: "NOT_CLAIMED", reasons: [`no cycle ${cycleId}`], sideEffects };
  }
  const reasons: string[] = [];
  if (cycle.status !== "CLAIMED") {
    return { cycle, disposition: "NOT_CLAIMED",
      reasons: [`cycle is ${cycle.status}, not CLAIMED — nothing to recover`], sideEffects };
  }
  if (!isClaimStale(cycle, now)) {
    const ageMin = cycle.claimedAt
      ? Math.round((now.getTime() - new Date(cycle.claimedAt).getTime()) / 60000) : 0;
    return { cycle, disposition: "NOT_STALE",
      reasons: [`claimed ${ageMin}min ago; threshold is ${CLAIM_STALE_AFTER_MS / 60000}min`],
      sideEffects };
  }

  const free = await ownerAppearsGone(channel);
  sideEffects.ownerAlive = !free;
  if (!free) {
    return { cycle, disposition: "OWNER_ALIVE",
      reasons: [`channel advisory lock ${channelLockId(channel)} is HELD — a pipeline ` +
        "session is running for this channel; it must never be reaped"], sideEffects };
  }
  reasons.push(`advisory lock ${channelLockId(channel)} is free — no live pipeline session`);

  sideEffects.videoId = cycle.videoId;
  if (!cycle.videoId) {
    reasons.push("no candidate was ever attached — nothing was produced");
    return { cycle, disposition: "SAFE_TO_FAIL", reasons, sideEffects };
  }

  // A candidate exists. Everything below decides whether the OUTSIDE WORLD may
  // have been touched, because that is the only thing that makes automatic
  // terminalisation unsafe.
  const table = VIDEO_TABLE[channel];
  const [vid] = await prisma.$queryRawUnsafe<{ youtubeId: string | null }[]>(
    `SELECT "youtubeId" FROM "${table}" WHERE "id" = $1`, cycle.videoId,
  );
  sideEffects.youtubeId = vid?.youtubeId ?? null;

  const [intents] = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "upload_intent"
      WHERE "videoId" = $1
        AND "state" NOT IN ('FAILED_BEFORE_REMOTE_CALL')`, cycle.videoId,
  );
  sideEffects.unresolvedIntents = intents?.n ?? 0;

  const [charges] = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COALESCE(sum("chargedChars"), 0)::int AS n FROM "elevenlabs_usage"
      WHERE "videoId" = $1 AND "success" = true`, cycle.videoId,
  );
  sideEffects.narrationCharges = charges?.n ?? 0;

  if (sideEffects.youtubeId) {
    reasons.push(`candidate ${cycle.videoId} carries youtubeId ${sideEffects.youtubeId} — ` +
      "a video exists on the channel");
    return { cycle, disposition: "NEEDS_RECONCILIATION", reasons, sideEffects };
  }
  if (sideEffects.unresolvedIntents > 0) {
    reasons.push(`candidate ${cycle.videoId} has ${sideEffects.unresolvedIntents} upload ` +
      "intent(s) that are not proven pre-remote failures — YouTube may hold an object");
    return { cycle, disposition: "NEEDS_RECONCILIATION", reasons, sideEffects };
  }

  reasons.push(`candidate ${cycle.videoId} never reached a remote call ` +
    `(no youtubeId, no unresolved intent; ${sideEffects.narrationCharges} narration chars charged)`);
  return { cycle, disposition: "SAFE_TO_FAIL", reasons, sideEffects };
}

export interface ReapResult {
  acted: boolean;
  newStatus: "FAILED" | "RECONCILIATION_REQUIRED" | null;
  reason: string;
  assessment: StaleAssessment;
}

/**
 * Terminalise an abandoned cycle, holding the channel lock throughout.
 *
 * The lock is not merely checked and released — it is HELD across the UPDATE.
 * A check-then-act would leave a window in which a container starts, claims the
 * cycle legitimately, and then has it reaped out from under it. Holding the lock
 * makes the reaper and a live pipeline mutually exclusive by the same mechanism
 * that already makes two pipelines mutually exclusive.
 *
 * The UPDATE re-asserts every precondition in its WHERE clause, so even if the
 * assessment were somehow stale by the time it runs, it matches zero rows rather
 * than acting on a changed cycle.
 */
export async function failAbandonedCycle(
  channel: string, cycleId: string, acknowledged: boolean, now = new Date(),
): Promise<ReapResult> {
  const lockId = channelLockId(channel);
  const [{ acquired }] = await prisma.$queryRawUnsafe<[{ acquired: boolean }]>(
    `SELECT pg_try_advisory_lock($1) AS acquired`, lockId,
  );
  if (!acquired) {
    const assessment = await inspectStaleCycle(channel, cycleId, now);
    return { acted: false, newStatus: null, assessment,
      reason: `refused: advisory lock ${lockId} is held — a pipeline session is running ` +
        "for this channel and its cycle must not be reaped" };
  }

  try {
    const assessment = await inspectStaleCycle(channel, cycleId, now);
    if (assessment.disposition !== "SAFE_TO_FAIL" &&
        assessment.disposition !== "NEEDS_RECONCILIATION") {
      return { acted: false, newStatus: null, assessment,
        reason: `refused: disposition is ${assessment.disposition}` };
    }
    if (!acknowledged) {
      return { acted: false, newStatus: null, assessment,
        reason: "refused: acknowledgement flag not passed" };
    }

    const newStatus = assessment.disposition === "SAFE_TO_FAIL"
      ? "FAILED" as const : "RECONCILIATION_REQUIRED" as const;
    const code = `abandoned: claim older than ${CLAIM_STALE_AFTER_MS / 60000}min, ` +
      `owner proven gone via advisory lock ${lockId}`;

    // Every precondition restated. Note what is NOT set: status never becomes
    // AUTHORIZED, claimantId is never cleared, videoId is never detached.
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE "production_cycle"
          SET "status" = $2, "failureCode" = $3, "failedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = $1
          AND "status" = 'CLAIMED'
          AND "claimedAt" IS NOT NULL
          AND "claimedAt" < $4`,
      cycleId, newStatus, code.slice(0, 500),
      new Date(now.getTime() - CLAIM_STALE_AFTER_MS),
    );
    if (affected !== 1) {
      return { acted: false, newStatus: null, assessment,
        reason: `refused: guarded UPDATE matched ${affected} rows — cycle changed underneath` };
    }
    return { acted: true, newStatus, assessment,
      reason: `cycle ${cycleId} → ${newStatus}` };
  } finally {
    await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, lockId);
  }
}
