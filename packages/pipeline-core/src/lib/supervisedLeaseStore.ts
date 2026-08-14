import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import {
  checkSupervisedLease, canRenew, canBind, leasesNeedingRecovery,
  LEASE_MAX_LIFETIME_MS,
} from "./supervisedLease";
import type {
  SupervisedLeaseRow, LeaseVerdict, BindRequest,
} from "./supervisedLease";
import type { ChannelKey } from "./runtimeTargets";

/**
 * Durable side of the supervised lease. The decisions live in
 * `supervisedLease.ts` and are pure; this only reads and writes rows.
 *
 * Every mutation is a conditional UPDATE rather than read-then-write, so two
 * reconcilers racing on the same abandoned lease settle on the same terminal
 * state instead of overwriting one another.
 */

const lease = () => (prisma as never as { supervisedLease: any }).supervisedLease;

export function newControllerToken(): string {
  return randomUUID();
}

/** The current ACTIVE lease for a channel, if any. At most one is expected. */
export async function activeLeaseFor(channel: string): Promise<SupervisedLeaseRow | null> {
  const rows = await lease().findMany({
    where: { channel, status: "ACTIVE" },
    orderBy: { openedAt: "desc" },
    take: 1,
  });
  return (rows[0] ?? null) as SupervisedLeaseRow | null;
}

/**
 * Open a lease. Refuses while another is live for the same channel, so two
 * supervised runs can never both hold authority.
 */
export async function openLease(input: {
  channel: ChannelKey;
  pilotId: string;
  controllerToken: string;
  videoId?: string | null;
  runId?: string | null;
  now?: Date;
}): Promise<{ opened: true; lease: SupervisedLeaseRow } | { opened: false; reason: string }> {
  const now = input.now ?? new Date();
  const existing = await activeLeaseFor(input.channel);
  if (existing) {
    // Only refuse for a lease that is still genuinely live; an abandoned one is
    // recovered first so a dead controller cannot block the channel forever.
    const verdict = checkSupervisedLease({ lease: existing, now, channel: input.channel });
    if (verdict.live) {
      return { opened: false, reason: `lease ${existing.id} is already live for ${input.channel}` };
    }
    await closeLease(existing.id, `superseded — ${verdict.reason}`, "EXPIRED", now);
  }
  const row = await lease().create({
    data: {
      channel: input.channel,
      pilotId: input.pilotId,
      controllerToken: input.controllerToken,
      videoId: input.videoId ?? null,
      runId: input.runId ?? null,
      status: "ACTIVE",
      openedAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + LEASE_MAX_LIFETIME_MS),
    },
  });
  return { opened: true, lease: row as SupervisedLeaseRow };
}

/**
 * Renew. Moves the heartbeat only — never `expiresAt`, so renewal cannot turn
 * a bounded authority into an unbounded one.
 */
export async function renewLease(
  id: string, controllerToken: string, now = new Date(),
): Promise<{ renewed: boolean; reason?: string }> {
  const row = (await lease().findUnique({ where: { id } })) as SupervisedLeaseRow | null;
  const allowed = canRenew(row, controllerToken, now);
  if (!allowed.ok) return { renewed: false, reason: allowed.reason };
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "supervised_lease" SET "heartbeatAt"=$2, "updatedAt"=NOW()
      WHERE "id"=$1 AND "status"='ACTIVE' AND "controllerToken"=$3 AND "expiresAt" > $2`,
    id, now, controllerToken,
  );
  return n === 1 ? { renewed: true } : { renewed: false, reason: "conditional update matched no row" };
}

/**
 * Bind the candidate/run once known, so the lease cannot be reused elsewhere.
 *
 * This existed from the start and was never called, which is why qualification
 * video #1 ran under a lease that named no candidate and no run: every
 * downstream check it passed was really only a channel/pilot check, and the
 * lease stayed adoptable by any candidate for its whole life.
 *
 * The previous body could not have closed that gap safely even if it had been
 * called. It accepted either id alone, so a lease could sit half-bound; it
 * re-bound an already-bound lease to different values without complaint; it
 * checked neither channel, pilot, ownership, expiry nor staleness; and it
 * returned `void`, so a caller could not fail closed on refusal.
 *
 * Now: `canBind` decides, and one conditional UPDATE applies it. Both ids move
 * together under `videoId IS NULL AND runId IS NULL`, so the transition is
 * atomic and monotonic — the database, not the caller, arbitrates the race, and
 * two executions starting together cannot both come away believing they own it.
 * A crash mid-statement leaves either a valid unbound lease or a valid fully
 * bound one; there is no partial identity to settle.
 *
 * Deliberately does NOT touch heartbeatAt or expiresAt: binding narrows
 * authority and must never extend it.
 */
export async function bindLease(
  id: string,
  req: BindRequest,
  now = new Date(),
): Promise<{ bound: true; alreadyBound: boolean } | { bound: false; reason: string }> {
  const row = (await lease().findUnique({ where: { id } })) as SupervisedLeaseRow | null;
  const allowed = canBind(row, req, now);
  if (!allowed.ok) return { bound: false, reason: allowed.reason };
  // Re-binding the identical identity changed nothing, so report it without a
  // write rather than racing an UPDATE whose precondition can no longer hold.
  if (allowed.alreadyBound) return { bound: true, alreadyBound: true };

  const n = await prisma.$executeRawUnsafe(
    `UPDATE "supervised_lease"
        SET "videoId"=$2, "runId"=$3, "updatedAt"=NOW()
      WHERE "id"=$1 AND "status"='ACTIVE'
        AND "channel"=$4 AND "pilotId"=$5
        AND "videoId" IS NULL AND "runId" IS NULL
        AND "expiresAt" > $6`,
    id, req.videoId, req.runId, req.channel, req.pilotId, now,
  );
  if (n === 1) return { bound: true, alreadyBound: false };
  // Lost the race, or the lease moved under us. Re-read so an execution that
  // bound the identical identity concurrently still succeeds, and one that
  // lost to a DIFFERENT execution is told exactly who won.
  const after = (await lease().findUnique({ where: { id } })) as SupervisedLeaseRow | null;
  const recheck = canBind(after, req, now);
  if (recheck.ok && recheck.alreadyBound) return { bound: true, alreadyBound: true };
  return {
    bound: false,
    reason: recheck.ok
      ? "conditional update matched no row"
      : recheck.reason,
  };
}

/** Terminal. Idempotent: closing an already-closed lease changes nothing. */
export async function closeLease(
  id: string, reason: string, status: "CLOSED" | "EXPIRED" = "CLOSED", now = new Date(),
): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "supervised_lease" SET "status"=$2, "closedAt"=$3, "closedReason"=$4, "updatedAt"=NOW()
      WHERE "id"=$1 AND "status"='ACTIVE'`,
    id, status, now, reason.slice(0, 500),
  );
  return n === 1;
}

/** The live-lease question, answered from durable state. */
export async function verifySupervision(input: {
  channel: ChannelKey; pilotId?: string; videoId?: string; runId?: string;
  requireBound?: boolean; now?: Date;
}): Promise<LeaseVerdict> {
  const row = await activeLeaseFor(input.channel);
  return checkSupervisedLease({
    lease: row, now: input.now ?? new Date(),
    channel: input.channel, pilotId: input.pilotId,
    videoId: input.videoId, runId: input.runId, requireBound: input.requireBound,
  });
}

/**
 * Close every abandoned or expired lease. Idempotent and safe to run
 * concurrently — the conditional UPDATE means a row can only be closed once.
 *
 * This is the recovery path that does NOT depend on the controller: it works
 * whether the controller exited cleanly, crashed, or was killed.
 */
export async function reconcileLeases(now = new Date()): Promise<
  { id: string; channel: string; reason: string }[]
> {
  const active = (await lease().findMany({ where: { status: "ACTIVE" } })) as SupervisedLeaseRow[];
  const recovered: { id: string; channel: string; reason: string }[] = [];
  for (const { lease: l, reason } of leasesNeedingRecovery(active, now)) {
    if (await closeLease(l.id, `reconciled: ${reason}`, "EXPIRED", now)) {
      recovered.push({ id: l.id, channel: l.channel, reason });
    }
  }
  return recovered;
}
