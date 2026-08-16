import { prisma } from "./db";
import {
  canAuthorizeTranche, canClaimSlot, canReleaseAttempt, checkSlotAuthority, liveTranche,
  settlementFor, tranchesNeedingRecovery, classifyTranchePhase, remainingCandidates,
  TRANCHE_DEFAULT_LIFETIME_MS,
} from "./productionTranche";
import type {
  ProductionTrancheRow, ProductionTrancheSlotRow, SlotAuthorityVerdict,
  TranchePhase,
} from "./productionTranche";
import type { ChannelKey } from "./runtimeTargets";

/**
 * Durable side of the production tranche. Decisions live in
 * `productionTranche.ts` and are pure; this reads and writes rows.
 *
 * The one genuinely delicate operation is claiming a slot, because that is
 * where capacity is spent. It runs inside a transaction that locks the tranche
 * row, so two production controllers reaching the last slot together are
 * serialized by the database rather than by hope.
 */

const tranche = () => (prisma as never as { productionTranche: any }).productionTranche;
const slot = () => (prisma as never as { productionTrancheSlot: any }).productionTrancheSlot;

/** The current live-ish tranche for a channel, if any. At most one is expected. */
export async function currentTranche(channel: string): Promise<ProductionTrancheRow | null> {
  const rows = await tranche().findMany({
    where: { channel, status: { in: ["ACTIVE", "EXHAUSTED"] } },
    orderBy: { authorizedAt: "desc" },
    take: 1,
  });
  return (rows[0] ?? null) as ProductionTrancheRow | null;
}

export async function slotsFor(trancheId: string): Promise<ProductionTrancheSlotRow[]> {
  return (await slot().findMany({
    where: { trancheId }, orderBy: { slotIndex: "asc" },
  })) as ProductionTrancheSlotRow[];
}

/**
 * Create an authorization. Spends nothing and starts nothing.
 *
 * Deliberately a separate operation from running: hiding tranche creation
 * inside `--run` would mean the command that produces a video also grants
 * itself permission to, which is the shape this whole mechanism exists to
 * avoid.
 */
export async function authorizeTranche(input: {
  channel: ChannelKey;
  count: number;
  graduated: boolean;
  authorizedBy: string;
  shortsEnabled?: boolean;
  policyCommit?: string | null;
  lifetimeMs?: number;
  now?: Date;
}): Promise<{ ok: true; tranche: ProductionTrancheRow } | { ok: false; reason: string }> {
  const now = input.now ?? new Date();
  const existing = await currentTranche(input.channel);
  const verdict = canAuthorizeTranche({
    channel: input.channel, count: input.count, graduated: input.graduated,
    existing, lifetimeMs: input.lifetimeMs, now,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const row = await tranche().create({
    data: {
      channel: input.channel,
      maxCandidates: input.count,
      consumedCandidates: 0,
      status: "ACTIVE",
      // Shorts are OFF unless a tranche explicitly says otherwise: the Shorts
      // path has never been exercised end to end, and a default of "on" would
      // put an unqualified upload into the very first production run.
      shortsEnabled: input.shortsEnabled ?? false,
      authorizedBy: input.authorizedBy,
      policyCommit: input.policyCommit ?? null,
      authorizedAt: now,
      expiresAt: new Date(now.getTime() + (input.lifetimeMs ?? TRANCHE_DEFAULT_LIFETIME_MS)),
    },
  });
  return { ok: true, tranche: row as ProductionTrancheRow };
}

/**
 * Take exactly one attempt, bound to this exact candidate and run.
 *
 * `SELECT ... FOR UPDATE` on the tranche row is what makes "two controllers,
 * one remaining slot" resolve to one winner: the second transaction blocks
 * until the first commits, then re-reads `consumedCandidates` and finds no
 * capacity. The unique index on (trancheId, slotIndex) is the belt to that
 * braces — even a hypothetical pair of simultaneous inserts cannot both land on
 * the same index.
 *
 * The increment and the slot insert are one transaction, so a crash mid-claim
 * leaves either "not consumed, no slot" or "consumed, slot bound". There is no
 * state in which capacity was spent but nothing records who spent it.
 */
export async function claimSlot(input: {
  channel: ChannelKey;
  videoId: string;
  runId: string;
  now?: Date;
}): Promise<{ ok: true; slot: ProductionTrancheSlotRow } | { ok: false; reason: string }> {
  const now = input.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<ProductionTrancheRow[]>(
        `SELECT * FROM "production_tranche"
          WHERE "channel" = $1 AND "status" = 'ACTIVE'
          ORDER BY "authorizedAt" DESC
          LIMIT 1
          FOR UPDATE`,
        input.channel,
      );
      const t = locked[0] ?? null;
      const verdict = canClaimSlot(t, {
        channel: input.channel, videoId: input.videoId, runId: input.runId, now,
      });
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason };

      const created = await (tx as never as { productionTrancheSlot: any })
        .productionTrancheSlot.create({
          data: {
            trancheId: t!.id, channel: input.channel, slotIndex: verdict.slotIndex,
            status: "CLAIMED", videoId: input.videoId, runId: input.runId, claimedAt: now,
          },
        });
      const consumed = t!.consumedCandidates + 1;
      await (tx as never as { productionTranche: any }).productionTranche.update({
        where: { id: t!.id },
        data: {
          consumedCandidates: consumed,
          // Retire the authorization the moment its last attempt is taken, so
          // nothing has to remember to close it later.
          ...(consumed >= t!.maxCandidates ? { status: "EXHAUSTED" } : {}),
        },
      });
      return { ok: true as const, slot: created as ProductionTrancheSlotRow };
    });
  } catch (err) {
    // A unique-constraint collision means another execution won the same index
    // or this candidate already holds a slot. Either way: refuse, never retry.
    return {
      ok: false,
      reason: `slot claim failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The live-authority question, answered from durable state at the moment of spend. */
export async function verifyProductionSlot(input: {
  channel: ChannelKey; videoId: string; runId: string; now?: Date;
}): Promise<SlotAuthorityVerdict> {
  const s = (await slot().findUnique({
    where: { videoId: input.videoId },
  })) as ProductionTrancheSlotRow | null;
  const t = s
    ? ((await tranche().findUnique({ where: { id: s.trancheId } })) as ProductionTrancheRow | null)
    : null;
  return checkSlotAuthority(s, t, {
    channel: input.channel, videoId: input.videoId, runId: input.runId,
    now: input.now ?? new Date(),
  });
}

/** Whether this tranche authorizes Shorts. Absent authority means no. */
export async function trancheShortsEnabled(videoId: string): Promise<boolean> {
  const s = (await slot().findUnique({ where: { videoId } })) as ProductionTrancheSlotRow | null;
  if (!s) return false;
  const t = (await tranche().findUnique({ where: { id: s.trancheId } })) as ProductionTrancheRow | null;
  return t?.shortsEnabled ?? false;
}

/**
 * Record what became of a claimed attempt. Never returns capacity.
 *
 * Conditional on the slot still being CLAIMED, so settling twice is a no-op
 * rather than a state change, and two reconcilers racing land on one result.
 */
export async function settleSlot(
  videoId: string,
  outcome: "SUCCESS" | "FAILED" | "AMBIGUOUS",
  detail: string,
  now = new Date(),
): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "production_tranche_slot"
        SET "status"=$2::"TrancheSlotStatus", "settledAt"=$3, "outcome"=$4, "updatedAt"=NOW()
      WHERE "videoId"=$1 AND "status"='CLAIMED'`,
    videoId, settlementFor(outcome), now, detail.slice(0, 500),
  );
  return n === 1;
}

/**
 * Give a consumed attempt back after a deterministic pre-spend failure.
 *
 * A tranche counts ATTEMPTS, and that is deliberate — a candidate that fails
 * quality has still used the authorisation it was given. But an attempt the
 * pipeline itself refused before spending anything cost a model call and
 * nothing more, and burning authorised capacity on it is waste, not safety.
 *
 * Narrow by construction. It is reached only from terminal settlement, only for
 * a classification the controller already decided was pre-spend, and only when
 * the durable evidence agrees: nothing charged for THIS run, no upload intent,
 * no render artifact. `MAX_RELEASES_PER_TRANCHE` stops a systematic fault from
 * retrying forever.
 *
 * `consumedCandidates` is never decremented, so `slotIndex` stays unique and a
 * released attempt stays visible; the released count is tracked alongside and
 * remaining capacity is the difference. One conditional UPDATE per side, guarded
 * on the slot still being unreleased, so calling twice releases once.
 */
export async function releaseProductionAttempt(input: {
  videoId: string;
  reason: string;
  classification: string;
  classificationIsPreSpend: boolean;
  chargedChars: number;
  uploadIntents: number;
  hasRenderArtifact: boolean;
  now?: Date;
}): Promise<{ released: boolean; capHit: boolean; reason: string }> {
  const now = input.now ?? new Date();
  const s = (await slot().findUnique({ where: { videoId: input.videoId } })) as ProductionTrancheSlotRow | null;
  const t = s ? ((await tranche().findUnique({ where: { id: s.trancheId } })) as ProductionTrancheRow | null) : null;
  const verdict = canReleaseAttempt({
    tranche: t, slot: s,
    classificationIsPreSpend: input.classificationIsPreSpend,
    chargedChars: input.chargedChars,
    uploadIntents: input.uploadIntents,
    hasRenderArtifact: input.hasRenderArtifact,
  });
  if (!verdict.ok) return { released: false, capHit: verdict.capHit, reason: verdict.reason };

  const marked = await prisma.$executeRawUnsafe(
    `UPDATE "production_tranche_slot"
        SET "status"='RELEASED'::"TrancheSlotStatus", "releasedAt"=$2,
            "releaseReason"=$3, "releaseClassification"=$4, "updatedAt"=NOW()
      WHERE "videoId"=$1 AND "status" <> 'RELEASED'`,
    input.videoId, now, input.reason.slice(0, 500), input.classification,
  );
  if (marked !== 1) return { released: false, capHit: false, reason: "already released" };

  await prisma.$executeRawUnsafe(
    `UPDATE "production_tranche"
        SET "releasedCandidates" = "releasedCandidates" + 1,
            "status" = CASE WHEN "status" = 'EXHAUSTED' THEN 'ACTIVE'::"ProductionTrancheStatus"
                            ELSE "status" END,
            "updatedAt" = NOW()
      WHERE "id"=$1`,
    s!.trancheId,
  );
  const after = (await tranche().findUnique({ where: { id: s!.trancheId } })) as ProductionTrancheRow;
  // The audit record: who, why, and what the counts became.
  console.log(
    `[tranche] RELEASED attempt — candidate ${s!.videoId} run ${s!.runId} ` +
    `classification ${input.classification} at ${now.toISOString()}: ${input.reason} ` +
    `| consumed ${after.consumedCandidates} released ${after.releasedCandidates} ` +
    `remaining ${remainingCandidates(after)}`);
  return { released: true, capHit: false, reason: "attempt returned to the tranche" };
}

export async function closeTranche(
  id: string, reason: string, status: "CLOSED" | "EXPIRED" = "CLOSED", now = new Date(),
): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "production_tranche"
        SET "status"=$2::"ProductionTrancheStatus", "closedAt"=$3, "closedReason"=$4, "updatedAt"=NOW()
      WHERE "id"=$1 AND "status" IN ('ACTIVE','EXHAUSTED')`,
    id, status, now, reason.slice(0, 500),
  );
  return n === 1;
}

/**
 * Retire expired and exhausted tranches. Idempotent, and incapable of
 * increasing capacity — the only writes are terminal status transitions.
 */
export async function reconcileTranches(now = new Date()): Promise<
  { id: string; channel: string; status: string; reason: string }[]
> {
  const active = (await tranche().findMany({ where: { status: "ACTIVE" } })) as ProductionTrancheRow[];
  const out: { id: string; channel: string; status: string; reason: string }[] = [];
  for (const { tranche: t, status, reason } of tranchesNeedingRecovery(active, now)) {
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "production_tranche"
          SET "status"=$2::"ProductionTrancheStatus", "closedAt"=$3, "closedReason"=$4, "updatedAt"=NOW()
        WHERE "id"=$1 AND "status"='ACTIVE'`,
      t.id, status, now, `reconciled: ${reason}`.slice(0, 500),
    );
    if (n === 1) out.push({ id: t.id, channel: t.channel, status, reason });
  }
  return out;
}

export interface TrancheReport {
  phase: TranchePhase;
  tranche: ProductionTrancheRow | null;
  slots: ProductionTrancheSlotRow[];
  remaining: number;
  live: boolean;
  reason: string;
}

/** Everything an operator needs without reading raw tables. */
export async function trancheReport(
  channel: string, now = new Date(),
): Promise<TrancheReport> {
  const t = await currentTranche(channel);
  const slots = t ? await slotsFor(t.id) : [];
  const l = liveTranche(t, now);
  return {
    phase: classifyTranchePhase(t, slots, now),
    tranche: t,
    slots,
    remaining: l.live ? l.remaining : 0,
    live: l.live,
    reason: l.live ? `${l.remaining} candidate attempt(s) remaining` : l.reason,
  };
}
