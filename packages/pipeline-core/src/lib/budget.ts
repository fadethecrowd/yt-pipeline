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

/**
 * The canonical hard ceiling across all channels and stages.
 *
 * ~300,000 credits are held; production targets stopping here, leaving a
 * reserve for corrections.
 */
export const DEFAULT_TOTAL_TARGET_CHARS = 297_000;

/**
 * Resolve the global ceiling, FAIL-CLOSED.
 *
 * This was `Number(process.env.ELEVEN_TOTAL_TARGET_CHARS ?? 297_000)`, which
 * silently removed the ceiling entirely. `Number("abc")` is NaN, and the guard
 * is `globalUsed + chars > TOTAL_TARGET_CHARS` — every comparison with NaN is
 * false, so a typo'd environment variable made the global check pass for any
 * amount. The per-stage limit still bound, but the one control that spans
 * every channel and stage was gone, and nothing said so.
 *
 * Now anything that is not a finite positive number falls back to the canonical
 * default. A misconfiguration therefore tightens to the known-safe value rather
 * than opening up, and says so loudly. Falling back rather than throwing is
 * deliberate: this module is imported by read-only operator tooling, and a
 * throw at import time would take the status and snapshot commands down at
 * exactly the moment someone is trying to diagnose a budget problem.
 */
export function resolveTotalTargetChars(
  raw: string | undefined = process.env.ELEVEN_TOTAL_TARGET_CHARS,
  warn: (m: string) => void = console.warn,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TOTAL_TARGET_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warn(`[budget] ELEVEN_TOTAL_TARGET_CHARS=${JSON.stringify(raw)} is not a positive ` +
      `finite number — falling back to the canonical ceiling ${DEFAULT_TOTAL_TARGET_CHARS}`);
    return DEFAULT_TOTAL_TARGET_CHARS;
  }
  if (n > DEFAULT_TOTAL_TARGET_CHARS) {
    warn(`[budget] ELEVEN_TOTAL_TARGET_CHARS=${n} exceeds the canonical ceiling ` +
      `${DEFAULT_TOTAL_TARGET_CHARS} — clamping. Raising the real ceiling is a ` +
      "deliberate decision that belongs in code, not an environment variable.");
    return DEFAULT_TOTAL_TARGET_CHARS;
  }
  return n;
}

/** Hard ceiling across all channels and stages. */
export const TOTAL_TARGET_CHARS = resolveTotalTargetChars();

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

/** Current limit for a budget row, or 0 when the row does not exist yet. */
export async function currentBudgetLimit(
  channel: string,
  stage: TestStage,
): Promise<number> {
  const b = await prisma.creditBudget.findUnique({
    where: { channel_testStage: { channel, testStage: stage } },
  });
  return b?.limitChars ?? 0;
}

/**
 * Open exactly enough headroom for one candidate, then close it again.
 *
 * A (channel, stage) limit is a stage-wide allowance: with the limit set for a
 * run, ANY candidate on that channel and stage may draw the whole of it. That
 * is not a per-candidate budget, and a runaway script would consume the lot
 * before anything noticed.
 *
 * So the window is opened to `charged + reserved + exactly the characters this
 * candidate will submit`, and restored to its prior value in a `finally`
 * whatever happens — including a throw, a refusal, or a partial narration. The
 * headroom is therefore finite, per-candidate, and gone the moment the
 * candidate finishes.
 *
 * `submitChars` must come from `spokenCharacterCount(buildSpokenUnits(script))`
 * — the bytes actually submitted to ElevenLabs — not from raw segment text,
 * which omits a folded hook and CTA and would under-open the window.
 *
 * The window is scoped to ONE (channel, stage) row, so a Wet Circuit candidate
 * at PRODUCTION cannot reach the AI Doom allowance, or the qualification one,
 * and neither can reach it.
 */
export async function withBudgetWindow<T>(
  channel: string,
  stage: TestStage,
  submitChars: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(submitChars) || submitChars < 0) {
    throw new Error(`withBudgetWindow: submitChars must be a non-negative number, got ${submitChars}`);
  }
  await ensureBudget(channel, stage);
  const before = await prisma.creditBudget.findUnique({
    where: { channel_testStage: { channel, testStage: stage } },
  });
  const priorLimit = before?.limitChars ?? 0;
  const openTo = (before?.chargedChars ?? 0) + (before?.reservedChars ?? 0) + submitChars;

  console.log(
    `[budget] ${channel}/${stage}: limit ${priorLimit} charged ${before?.chargedChars ?? 0} ` +
    `reserved ${before?.reservedChars ?? 0} → opening to ${openTo} (exactly ${submitChars} chars)`,
  );

  try {
    await setBudgetLimit(channel, stage, openTo);
    return await fn();
  } finally {
    await setBudgetLimit(channel, stage, priorLimit);
    const after = await prisma.creditBudget.findUnique({
      where: { channel_testStage: { channel, testStage: stage } },
    });
    console.log(
      `[budget] ${channel}/${stage}: relocked — limit ${after?.limitChars} ` +
      `charged ${after?.chargedChars} reserved ${after?.reservedChars}`,
    );
  }
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
