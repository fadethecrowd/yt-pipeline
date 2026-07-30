import { prisma } from "./db";

/**
 * Production circuit breaker.
 *
 * While a breaker is tripped, no new generation job may start for that
 * channel. In-flight jobs are allowed to reach a safe stopping point — the
 * breaker is checked at job-launch boundaries, not mid-render — and all logs
 * and artifacts are preserved for post-mortem.
 *
 * Clearing is deliberate and manual (`clearBreaker`), after the failed path
 * has passed a fresh diagnostic and the relevant qualification test.
 */

export type BreakerTrigger =
  | "AV_SYNC_FAILURE"
  | "CAPTION_OFFSET_FAILURE"
  | "CAPTION_DRIFT_FAILURE"
  | "BAD_VISUAL_OUTPUT"
  | "WRONG_CHANNEL_AUTH"
  | "DUPLICATE_GENERATION"
  | "DUPLICATE_UPLOAD"
  | "UNEXPECTED_CREDIT_CONSUMPTION"
  | "MISSING_QA_RECORD"
  | "RENDER_FAILURE_RATE"
  | "REPEATED_GENERATION_SAME_SCRIPT"
  | "PRIVATE_CONTENT_WENT_PUBLIC"
  | "CROSS_CHANNEL_CONTAMINATION"
  | "REPEATED_VISUAL_VALIDATION_FAILURE"
  | "SERVICE_UNHEALTHY";

/** Applies to every channel. */
export const GLOBAL = "*";

export class CircuitOpenError extends Error {
  constructor(channel: string, trigger: string, detail: string | null) {
    super(
      `Circuit breaker OPEN for ${channel} — trigger=${trigger}. ${detail ?? ""} ` +
        `New generation is blocked until the failed path passes a fresh diagnostic ` +
        `and qualification test, then the breaker is cleared explicitly.`,
    );
    this.name = "CircuitOpenError";
  }
}

export async function tripBreaker(
  channel: string,
  trigger: BreakerTrigger,
  detail: string,
  affectedJobs: string[] = [],
): Promise<void> {
  await prisma.circuitBreaker.upsert({
    where: { channel },
    create: {
      channel, tripped: true, trigger, detail: detail.slice(0, 2000),
      affectedJobs, trippedAt: new Date(),
    },
    update: {
      tripped: true, trigger, detail: detail.slice(0, 2000),
      affectedJobs, trippedAt: new Date(), clearedAt: null, clearedBy: null,
    },
  });
  await prisma.circuitBreakerEvent.create({
    data: {
      channel, event: "TRIP", trigger, detail: detail.slice(0, 2000),
      videoId: affectedJobs[0] ?? null,
    },
  });
  console.error(
    `[breaker] TRIPPED channel=${channel} trigger=${trigger} jobs=[${affectedJobs.join(",")}] — ${detail}`,
  );
}

/**
 * Throws CircuitOpenError if the channel's breaker (or the global breaker) is
 * open. Call this before launching any new generation job — never mid-render.
 */
export async function assertCircuitClosed(channel: string): Promise<void> {
  const rows = await prisma.circuitBreaker.findMany({
    where: { channel: { in: [channel, GLOBAL] }, tripped: true },
  });
  if (rows.length > 0) {
    const r = rows[0];
    throw new CircuitOpenError(r.channel, r.trigger ?? "unknown", r.detail);
  }
}

export async function clearBreaker(
  channel: string,
  clearedBy: string,
  note = "",
): Promise<void> {
  await prisma.circuitBreaker.updateMany({
    where: { channel },
    data: { tripped: false, clearedAt: new Date(), clearedBy },
  });
  await prisma.circuitBreakerEvent.create({
    data: { channel, event: "CLEAR", trigger: "manual", detail: `${clearedBy}: ${note}` },
  });
  console.log(`[breaker] CLEARED channel=${channel} by=${clearedBy} ${note}`);
}

export async function breakerStatus() {
  return prisma.circuitBreaker.findMany({ orderBy: { channel: "asc" } });
}

/**
 * Trip the breaker when the recent render failure rate exceeds `threshold`.
 * Evaluated over the last `window` pipeline runs for the channel.
 */
export async function checkRenderFailureRate(
  channel: string,
  threshold = 0.5,
  window = 6,
): Promise<void> {
  const runs = await prisma.pipelineRun.findMany({
    where: { channel, runMode: "LIVE" },
    orderBy: { createdAt: "desc" },
    take: window,
  });
  if (runs.length < window) return;
  const failed = runs.filter((r) => r.status === "FAILED" || r.status === "CRITICAL").length;
  const rate = failed / runs.length;
  if (rate > threshold) {
    await tripBreaker(
      channel, "RENDER_FAILURE_RATE",
      `${failed}/${runs.length} of the last LIVE runs failed (${(rate * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}%)`,
      runs.filter((r) => r.videoId).map((r) => r.videoId!),
    );
  }
}
