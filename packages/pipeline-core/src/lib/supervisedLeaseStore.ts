import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import {
  checkSupervisedLease, canRenew, leasesNeedingRecovery,
  LEASE_MAX_LIFETIME_MS,
} from "./supervisedLease";
import type {
  SupervisedLeaseRow, LeaseVerdict,
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

/** Bind the candidate/run once known, so the lease cannot be reused elsewhere. */
export async function bindLease(
  id: string, bind: { videoId?: string; runId?: string },
): Promise<void> {
  await lease().updateMany({
    where: { id, status: "ACTIVE" },
    data: { ...(bind.videoId ? { videoId: bind.videoId } : {}), ...(bind.runId ? { runId: bind.runId } : {}) },
  });
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
  channel: ChannelKey; pilotId?: string; videoId?: string; now?: Date;
}): Promise<LeaseVerdict> {
  const row = await activeLeaseFor(input.channel);
  return checkSupervisedLease({
    lease: row, now: input.now ?? new Date(),
    channel: input.channel, pilotId: input.pilotId, videoId: input.videoId,
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
