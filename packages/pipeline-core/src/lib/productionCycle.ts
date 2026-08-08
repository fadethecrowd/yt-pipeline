import { prisma } from "./db";
import { nextPublishSlot, PUBLISH_DAYS, PUBLISH_HOUR_LOCAL, PUBLISH_TIMEZONE } from "./publishSlot";
import { zonedParts } from "./easternWindow";

/**
 * Durable authorization for exactly ONE ordinary production cycle.
 *
 * Neither channel has a recurring trigger — no cron, no schedule, no monitor
 * hook — and a successful run exits 0 under ON_FAILURE. Ordinary production
 * therefore happens only when a container starts, and with the pipeline
 * unlocked ANY start (deploy, restart, env change, infrastructure event) would
 * reach discovery and create a video. Nothing durable said whether a video was
 * owed, so "today is Monday" was the only thing standing between a redeploy and
 * an extra upload. That is not an authorization.
 *
 * A cycle is identified by the intended PUBLICATION slot, never by container
 * start time, so a restart at any hour resolves to the same cycle rather than a
 * new one. The unique constraint on (channel, targetPublishSlot) is the whole
 * guarantee: a duplicate scheduler event collides and becomes a no-op.
 *
 * Raw SQL throughout, matching the existing pilot operations. The repository
 * carries two Prisma schemas that generate into one client — the monitor's is a
 * superset — so whichever generated last decides which models the client
 * exposes. Raw statements do not care, and every transition here needs an
 * explicit compare-and-set anyway.
 */

export type CycleStatus =
  | "AUTHORIZED"
  | "CLAIMED"
  | "COMPLETED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export interface ProductionCycle {
  id: string;
  channel: string;
  targetPublishSlot: Date;
  status: CycleStatus;
  claimantId: string | null;
  videoId: string | null;
  pipelineRunId: string | null;
  failureCode: string | null;
  authorizedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export class CycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CycleError";
  }
}

/**
 * A slot is only a valid cycle target if it is an actual ordinary publication
 * slot: Mon/Wed/Fri at 15:00 in the publication timezone, on the second.
 *
 * Checked in local wall-clock terms, so the same calendar slot is one identity
 * in summer and winter even though its UTC instant differs by an hour.
 */
export function assertValidSlot(slot: Date, timeZone = PUBLISH_TIMEZONE): void {
  if (!Number.isFinite(slot.getTime())) {
    throw new CycleError("CYCLE_SLOT_INVALID", "target publish slot is not a date");
  }
  const p = zonedParts(slot, timeZone);
  if (!PUBLISH_DAYS.includes(p.weekday)) {
    throw new CycleError("CYCLE_SLOT_WRONG_DAY",
      `slot weekday ${p.weekday} is not in ${JSON.stringify(PUBLISH_DAYS)} (1=Mon)`);
  }
  if (p.hour !== PUBLISH_HOUR_LOCAL || p.minute !== 0 || p.second !== 0) {
    throw new CycleError("CYCLE_SLOT_WRONG_TIME",
      `slot reads ${p.hour}:${String(p.minute).padStart(2, "0")}:` +
      `${String(p.second).padStart(2, "0")} local, expected ${PUBLISH_HOUR_LOCAL}:00:00`);
  }
}

/** The slot an unattended run would target right now, skipping occupied ones. */
export async function nextCycleSlot(channel: string, now = new Date()): Promise<Date> {
  const model = channel === "ai-doom-scroll" ? "video" : "wc_video";
  const rows = await prisma.$queryRawUnsafe<{ scheduledAt: Date }[]>(
    `SELECT "scheduledAt" FROM "${model}" WHERE "scheduledAt" > $1`, now,
  );
  return nextPublishSlot(now, { occupied: rows.map((r) => r.scheduledAt) });
}

async function readCycle(channel: string, slot: Date): Promise<ProductionCycle | null> {
  const rows = await prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle" WHERE "channel" = $1 AND "targetPublishSlot" = $2`,
    channel, slot,
  );
  return rows[0] ?? null;
}

/**
 * Authorize one cycle. Idempotent by construction.
 *
 * A second call for the same channel and slot does NOT create another row — the
 * unique index forbids it — and returns the existing cycle instead. That is what
 * makes a duplicate scheduler event harmless.
 */
export async function authorizeCycle(
  channel: string, targetPublishSlot: Date,
): Promise<{ cycle: ProductionCycle; created: boolean }> {
  assertValidSlot(targetPublishSlot);
  const existing = await readCycle(channel, targetPublishSlot);
  if (existing) return { cycle: existing, created: false };

  // ON CONFLICT makes the race between two schedulers a no-op rather than an
  // error: whoever loses simply reads the winner's row.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "production_cycle"
       ("id", "channel", "targetPublishSlot", "status", "authorizedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'AUTHORIZED', NOW(), NOW(), NOW())
     ON CONFLICT ("channel", "targetPublishSlot") DO NOTHING`,
    channel, targetPublishSlot,
  );
  const cycle = await readCycle(channel, targetPublishSlot);
  if (!cycle) throw new CycleError("CYCLE_AUTHORIZE_FAILED", "cycle row not found after insert");
  return { cycle, created: !existing };
}

/**
 * The cycle a starting container may run, or null.
 *
 * Null is the ordinary answer and means "no video is owed" — the runner must
 * then exit before discovery. A CLAIMED cycle is returned so a crashed run can
 * be resumed by the next start; COMPLETED, FAILED and RECONCILIATION_REQUIRED
 * are terminal and never returned.
 */
export async function currentRunnableCycle(
  channel: string, now = new Date(),
): Promise<ProductionCycle | null> {
  const rows = await prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle"
      WHERE "channel" = $1
        AND "status" IN ('AUTHORIZED', 'CLAIMED')
        AND "targetPublishSlot" > $2
      ORDER BY "targetPublishSlot" ASC
      LIMIT 1`,
    channel, now,
  );
  return rows[0] ?? null;
}

/**
 * Take ownership of a cycle. Exactly one caller wins.
 *
 * The guard is inside the UPDATE, so two containers starting simultaneously
 * cannot both proceed: one matches a row, the other matches none. Re-claiming a
 * cycle this same claimant already holds is allowed, which is what makes crash
 * recovery work — a restarted process resumes rather than being locked out.
 */
export async function claimCycle(
  cycleId: string, claimantId: string,
): Promise<ProductionCycle | null> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "production_cycle"
        SET "status" = 'CLAIMED', "claimantId" = $2,
            "claimedAt" = COALESCE("claimedAt", NOW()), "updatedAt" = NOW()
      WHERE "id" = $1
        AND "status" IN ('AUTHORIZED', 'CLAIMED')
        AND ("claimantId" IS NULL OR "claimantId" = $2)`,
    cycleId, claimantId,
  );
  if (affected !== 1) return null;
  const rows = await prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle" WHERE "id" = $1`, cycleId,
  );
  return rows[0] ?? null;
}

/**
 * Bind the one candidate this cycle is permitted to produce.
 *
 * Compare-and-set on `videoId IS NULL`, so a second attempt — from a racing
 * process or a confused resume — matches nothing. This is the point at which
 * "one authorization, one candidate" becomes durable, and it is why the caller
 * must attach immediately after creating the row.
 */
export async function attachVideo(
  cycleId: string, claimantId: string, videoId: string, pipelineRunId?: string,
): Promise<boolean> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "production_cycle"
        SET "videoId" = $3, "pipelineRunId" = COALESCE($4, "pipelineRunId"), "updatedAt" = NOW()
      WHERE "id" = $1 AND "claimantId" = $2
        AND "status" = 'CLAIMED' AND "videoId" IS NULL`,
    cycleId, claimantId, videoId, pipelineRunId ?? null,
  );
  return affected === 1;
}

/** Terminal success. Requires the cycle to actually carry its video. */
export async function completeCycle(cycleId: string, claimantId: string): Promise<boolean> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "production_cycle"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
      WHERE "id" = $1 AND "claimantId" = $2
        AND "status" = 'CLAIMED' AND "videoId" IS NOT NULL`,
    cycleId, claimantId,
  );
  return affected === 1;
}

/**
 * Terminal failure, or a hold for reconciliation.
 *
 * An ambiguous upload is NOT a failure to retry — it means a video may exist
 * that we have not recorded — so it parks the cycle in
 * RECONCILIATION_REQUIRED, which `currentRunnableCycle` never returns. A human
 * decides what happens next.
 */
export async function failCycle(
  cycleId: string, claimantId: string, failureCode: string,
  needsReconciliation = false,
): Promise<boolean> {
  const status: CycleStatus = needsReconciliation ? "RECONCILIATION_REQUIRED" : "FAILED";
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "production_cycle"
        SET "status" = $3, "failureCode" = $4, "failedAt" = NOW(), "updatedAt" = NOW()
      WHERE "id" = $1 AND "claimantId" = $2 AND "status" = 'CLAIMED'`,
    cycleId, claimantId, status, failureCode,
  );
  return affected === 1;
}

/** Read a cycle by id. */
export async function getCycle(cycleId: string): Promise<ProductionCycle | null> {
  const rows = await prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle" WHERE "id" = $1`, cycleId,
  );
  return rows[0] ?? null;
}

/** Every cycle for a channel, newest slot first. Read-only reporting. */
export async function listCycles(channel: string, limit = 20): Promise<ProductionCycle[]> {
  return prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle" WHERE "channel" = $1
      ORDER BY "targetPublishSlot" DESC LIMIT ${Math.max(1, Math.min(100, limit))}`,
    channel,
  );
}
