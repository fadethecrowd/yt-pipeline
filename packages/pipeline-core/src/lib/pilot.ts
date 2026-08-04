import { prisma } from "./db";

/**
 * A bounded, private-only production pilot.
 *
 * The controls a pilot needs — at most three videos, never public, never
 * scheduled, no Shorts — cannot live in a process. A redeploy restarts the
 * process; a crash loses whatever it was counting; two invocations racing can
 * both believe they are the third. So the limit and the count live in one
 * durable row, and a slot is CLAIMED before the upload by a conditional
 * UPDATE that only matches while the count is below the maximum. That is the
 * same shape as credit reservation, which is already the proven pattern here.
 *
 * A claimed slot that does not result in an upload is released, so an
 * abandoned attempt never burns one of the three.
 */

export type PilotStatus = "PREPARED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "FAILED";

export interface PilotConfig {
  id: string;
  pilotId: string;
  channel: string;
  channelId: string;
  status: PilotStatus;
  maxSuccesses: number;
  successCount: number;
  successVideoIds: string[];
  activatedAt: Date | null;
  completedAt: Date | null;
  privacyStatus: string;
  allowPublishAt: boolean;
  shortsEnabled: boolean;
  requireFeasibility: boolean;
  requireGuardedUpload: boolean;
  windowDays: number[];
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
}

export class PilotBlockedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PilotBlockedError";
  }
}

/** Env selects the pilot. Absent means ordinary, non-pilot production. */
export function activePilotId(): string | null {
  const id = process.env.PILOT_ID?.trim();
  return id && id.length > 0 ? id : null;
}

export async function getPilot(pilotId: string): Promise<PilotConfig | null> {
  const row = await (prisma as never as { productionPilot: { findUnique: Function } })
    .productionPilot.findUnique({ where: { pilotId } });
  return (row as PilotConfig) ?? null;
}

/**
 * The pilot governing this run, or null when not in pilot mode.
 *
 * Fails closed rather than falling back to unrestricted production: naming a
 * pilot that does not exist, or one that is not running, must stop the run,
 * not quietly grant it ordinary production's freedoms.
 */
export async function currentPilot(): Promise<PilotConfig | null> {
  const id = activePilotId();
  if (!id) return null;
  const p = await getPilot(id);
  if (!p) throw new PilotBlockedError("PILOT_NOT_FOUND", `PILOT_ID=${id} does not exist`);
  return p;
}

/** Runnable only while ACTIVE — PREPARED means "not yet authorised to run". */
export function assertRunnable(p: PilotConfig): void {
  if (p.status !== "ACTIVE") {
    throw new PilotBlockedError(
      "PILOT_NOT_ACTIVE",
      `pilot ${p.pilotId} is ${p.status}; only ACTIVE may run`,
    );
  }
  if (!p.activatedAt) {
    throw new PilotBlockedError("PILOT_NOT_ACTIVATED", `pilot ${p.pilotId} has no activation time`);
  }
  if (p.successCount >= p.maxSuccesses) {
    throw new PilotBlockedError(
      "PILOT_CAP_REACHED",
      `pilot ${p.pilotId} has ${p.successCount}/${p.maxSuccesses} successful uploads`,
    );
  }
}

/** Remaining slots, from the durable row rather than anything in memory. */
export async function remainingSlots(pilotId: string): Promise<number> {
  const p = await getPilot(pilotId);
  if (!p) return 0;
  return Math.max(0, p.maxSuccesses - p.successCount);
}

/**
 * Claim one of the pilot's slots.
 *
 * The guard is inside the UPDATE, so two processes cannot both read "two used"
 * and both proceed: exactly one row update matches, the other sees zero rows
 * affected and is refused. Returns the slot number claimed.
 */
export async function claimPilotSlot(pilotId: string): Promise<number> {
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "production_pilot"
        SET "successCount" = "successCount" + 1, "updatedAt" = NOW()
      WHERE "pilotId" = $1
        AND "status" = 'ACTIVE'
        AND "successCount" < "maxSuccesses"`,
    pilotId,
  );
  if (affected !== 1) {
    const p = await getPilot(pilotId);
    throw new PilotBlockedError(
      "PILOT_CAP_REACHED",
      p
        ? `pilot ${pilotId} is ${p.status} with ${p.successCount}/${p.maxSuccesses} used — no slot available`
        : `pilot ${pilotId} does not exist`,
    );
  }
  const after = await getPilot(pilotId);
  return after!.successCount;
}

/** Give a claimed slot back when the upload did not complete. */
export async function releasePilotSlot(pilotId: string): Promise<void> {
  // Never drop below the number of confirmed uploads: a release must undo a
  // claim, never erase a video that actually exists.
  await prisma.$executeRawUnsafe(
    `UPDATE "production_pilot"
        SET "successCount" = GREATEST("successCount" - 1, COALESCE(array_length("successVideoIds", 1), 0)),
            "updatedAt" = NOW()
      WHERE "pilotId" = $1`,
    pilotId,
  );
}

/**
 * Record a confirmed upload against its claimed slot, completing the pilot
 * when the last one lands.
 */
export async function confirmPilotSlot(pilotId: string, videoId: string): Promise<PilotConfig> {
  await prisma.$executeRawUnsafe(
    `UPDATE "production_pilot"
        SET "successVideoIds" = array_append("successVideoIds", $2), "updatedAt" = NOW()
      WHERE "pilotId" = $1 AND NOT ($2 = ANY("successVideoIds"))`,
    pilotId, videoId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "production_pilot"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
      WHERE "pilotId" = $1
        AND "status" = 'ACTIVE'
        AND COALESCE(array_length("successVideoIds", 1), 0) >= "maxSuccesses"`,
    pilotId,
  );
  return (await getPilot(pilotId))!;
}

/**
 * The upload policy a run must obey.
 *
 * A pilot is private with no publish time, full stop. Ordinary production is
 * untouched and keeps its scheduled slot — the pilot restriction is scoped to
 * the pilot, not baked into PRODUCTION forever.
 */
export interface UploadPolicy {
  privacyStatus: "private";
  /** Null forbids any publish time; a Date is an ordinary scheduled release. */
  scheduledSlot: Date | null;
  shortsEnabled: boolean;
  requireGuardedUpload: boolean;
  source: "pilot" | "normal";
}

export function uploadPolicyFor(pilot: PilotConfig | null, normalSlot: Date | null): UploadPolicy {
  if (!pilot) {
    return {
      privacyStatus: "private", scheduledSlot: normalSlot,
      shortsEnabled: true, requireGuardedUpload: true, source: "normal",
    };
  }
  if (pilot.privacyStatus !== "private") {
    throw new PilotBlockedError(
      "PILOT_NOT_PRIVATE", `pilot ${pilot.pilotId} declares privacy "${pilot.privacyStatus}"`,
    );
  }
  if (pilot.allowPublishAt) {
    throw new PilotBlockedError(
      "PILOT_ALLOWS_PUBLISH", `pilot ${pilot.pilotId} must not permit a publish time`,
    );
  }
  return {
    privacyStatus: "private", scheduledSlot: null,
    shortsEnabled: pilot.shortsEnabled,
    requireGuardedUpload: pilot.requireGuardedUpload,
    source: "pilot",
  };
}

/** Fail closed on anything that would publish or schedule a pilot upload. */
export function assertPilotUploadAllowed(policy: UploadPolicy, publishAt: Date | string | null): void {
  if (policy.source !== "pilot") return;
  if (policy.privacyStatus !== "private") {
    throw new PilotBlockedError("PILOT_NOT_PRIVATE", `privacy is ${policy.privacyStatus}`);
  }
  if (policy.scheduledSlot !== null) {
    throw new PilotBlockedError("PILOT_SLOT_PRESENT", "a pilot upload carried a scheduled slot");
  }
  if (publishAt !== null && publishAt !== undefined) {
    throw new PilotBlockedError("PILOT_PUBLISH_AT_SET", `publishAt is ${String(publishAt)}`);
  }
}
