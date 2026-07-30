import type { TestStage } from "@prisma/client";
import { prisma } from "./db";

/**
 * Credit-budget control.
 *
 * The account holds ~300,000 ElevenLabs credits. Production is targeted to
 * stop at TOTAL_TARGET_CHARS, leaving a small reserve for corrections.
 *
 * Reservation is atomic: `reserveCredits` increments `reservedChars` inside a
 * conditional UPDATE, so two pipelines racing on the same budget row cannot
 * both pass the limit check. `settleCredits` then swaps the estimate for the
 * real `character-cost` reported by the API.
 */

/** Hard ceiling across all channels and stages. */
export const TOTAL_TARGET_CHARS = Number(
  process.env.ELEVEN_TOTAL_TARGET_CHARS ?? 297_000,
);

/** Default per-(channel, stage) allocations, applied on first use. */
const DEFAULT_LIMITS: Record<TestStage, number> = {
  DIAGNOSTIC: 6_000,
  QUALIFICATION: 60_000,
  RETEST: 20_000,
  REPEATABILITY: 60_000,
  // Production stays locked at 0 until the acceptance gate passes; unlock
  // deliberately with `setBudgetLimit`.
  PRODUCTION: 0,
};

export class BudgetExceededError extends Error {
  constructor(
    readonly channel: string,
    readonly stage: TestStage,
    readonly requested: number,
    readonly remaining: number,
  ) {
    super(
      `Credit budget exhausted for ${channel}/${stage}: requested ${requested} chars, ${remaining} remaining. ` +
        `Raise the limit deliberately with setBudgetLimit() — do not bypass.`,
    );
    this.name = "BudgetExceededError";
  }
}

async function ensureBudget(channel: string, stage: TestStage) {
  return prisma.creditBudget.upsert({
    where: { channel_testStage: { channel, testStage: stage } },
    create: { channel, testStage: stage, limitChars: DEFAULT_LIMITS[stage] },
    update: {},
  });
}

/**
 * Reserve `chars` against (channel, stage). Throws BudgetExceededError if the
 * reservation would exceed either the stage limit or the global target.
 */
export async function reserveCredits(
  channel: string,
  stage: TestStage,
  chars: number,
): Promise<void> {
  await ensureBudget(channel, stage);

  // Global ceiling across everything already spent or in flight.
  const all = await prisma.creditBudget.aggregate({
    _sum: { chargedChars: true, reservedChars: true },
  });
  const globalUsed = (all._sum.chargedChars ?? 0) + (all._sum.reservedChars ?? 0);
  if (globalUsed + chars > TOTAL_TARGET_CHARS) {
    throw new BudgetExceededError(
      channel, stage, chars, Math.max(0, TOTAL_TARGET_CHARS - globalUsed),
    );
  }

  // Atomic conditional increment — the WHERE clause is the race guard.
  const updated = await prisma.$executeRaw`
    UPDATE credit_budget
       SET "reservedChars" = "reservedChars" + ${chars},
           "updatedAt"     = NOW()
     WHERE "channel"   = ${channel}
       AND "testStage" = ${stage}::"TestStage"
       AND "enabled"   = TRUE
       AND "chargedChars" + "reservedChars" + ${chars} <= "limitChars"`;

  if (updated === 0) {
    const b = await prisma.creditBudget.findUnique({
      where: { channel_testStage: { channel, testStage: stage } },
    });
    const remaining = b ? b.limitChars - b.chargedChars - b.reservedChars : 0;
    throw new BudgetExceededError(channel, stage, chars, Math.max(0, remaining));
  }
}

/**
 * Release a reservation and record the real charge. `actual` comes from the
 * API's `character-cost` header — never assume 1 credit per character.
 */
export async function settleCredits(
  channel: string,
  stage: TestStage,
  reserved: number,
  actual: number,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE credit_budget
       SET "reservedChars" = GREATEST(0, "reservedChars" - ${reserved}),
           "chargedChars"  = "chargedChars" + ${actual},
           "updatedAt"     = NOW()
     WHERE "channel"   = ${channel}
       AND "testStage" = ${stage}::"TestStage"`;
}

export async function setBudgetLimit(
  channel: string,
  stage: TestStage,
  limitChars: number,
): Promise<void> {
  await prisma.creditBudget.upsert({
    where: { channel_testStage: { channel, testStage: stage } },
    create: { channel, testStage: stage, limitChars },
    update: { limitChars },
  });
}

export interface BudgetReport {
  rows: {
    channel: string;
    stage: TestStage;
    limit: number;
    charged: number;
    reserved: number;
    remaining: number;
    enabled: boolean;
  }[];
  totalCharged: number;
  totalReserved: number;
  globalTarget: number;
  globalRemaining: number;
}

export async function budgetReport(): Promise<BudgetReport> {
  const budgets = await prisma.creditBudget.findMany({
    orderBy: [{ channel: "asc" }, { testStage: "asc" }],
  });
  const totalCharged = budgets.reduce((a, b) => a + b.chargedChars, 0);
  const totalReserved = budgets.reduce((a, b) => a + b.reservedChars, 0);
  return {
    rows: budgets.map((b) => ({
      channel: b.channel,
      stage: b.testStage,
      limit: b.limitChars,
      charged: b.chargedChars,
      reserved: b.reservedChars,
      remaining: b.limitChars - b.chargedChars - b.reservedChars,
      enabled: b.enabled,
    })),
    totalCharged,
    totalReserved,
    globalTarget: TOTAL_TARGET_CHARS,
    globalRemaining: TOTAL_TARGET_CHARS - totalCharged - totalReserved,
  };
}
