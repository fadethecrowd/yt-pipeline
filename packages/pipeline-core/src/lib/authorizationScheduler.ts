import type { ProductionCycle } from "./productionCycle";
import { authorizeCycle, currentRunnableCycle, nextCycleSlot, assertValidSlot, CycleError } from "./productionCycle";
import { describeSlot } from "./publishSlot";
import { PIPELINE_HARD_TIMEOUT_MS } from "./runtimeLimits";

/**
 * The trigger layer: the thing that decides a video is OWED.
 *
 * It authorizes a ProductionCycle and does nothing else. It cannot run a
 * pipeline, cannot spend narration credits, cannot render and cannot upload —
 * not by policy but by construction, since it imports none of that. Its entire
 * blast radius is one INSERT into `production_cycle`, and the unique index on
 * (channel, targetPublishSlot) bounds even that to one row per slot.
 *
 * Keeping authorization separate from execution is what makes the whole design
 * safe: a scheduler bug can at worst cause one extra authorization, which the
 * unattended gate then turns into at most one video. A scheduler that ran the
 * pipeline directly would have no such backstop.
 *
 * WHY A POLLED TICK RATHER THAN A CRON EXPRESSION
 *
 * The publication policy is stated in America/New_York, and Eastern shifts by
 * an hour twice a year. Encoding it as a UTC cron means either two expressions
 * that must be swapped on the right dates, or a schedule that silently drifts —
 * exactly the defect that was already fixed once in publishSlot.ts, where a
 * fixed `PUBLISH_HOUR_UTC = 19` was publishing at 15:00 EDT in summer and 14:00
 * EST in winter. So the tick carries no schedule of its own. It runs often,
 * asks the timezone-aware policy what the next slot is, and acts only inside a
 * lead window measured in absolute milliseconds from that slot. DST correctness
 * therefore lives in one place that is already tested, and the tick frequency
 * is free to be whatever is operationally convenient.
 */

/** Exact literal required to permit any write. Anything else means disabled. */
export const SCHEDULER_ENABLED_VALUE = "true";

/**
 * How long before its publication slot a cycle is authorized.
 *
 * Derived from measured runtime, not chosen. Audited 2026-08-09 against
 * `pipeline_run` LIVE successes: wet-circuit worst 13.3 min (n=6, avg 9.5),
 * ai-doom-scroll worst 9.2 min (n=5, avg 7.0). The hard ceiling on any run is
 * PIPELINE_HARD_TIMEOUT_MS (30 min), after which the process kills itself.
 *
 * Six hours is twelve times the worst observed successful run, and leaves room
 * for the sequence that actually matters operationally: a run fails or hangs
 * (≤30 min to find out), a human notices, and a full manual retry is still
 * possible well before the 15:00 ET publication slot. Authorizing at ~09:00 ET
 * for a 15:00 ET slot is the concrete shape of that.
 *
 * It is deliberately NOT larger. A longer lead would mean authorizing the next
 * slot while the previous one is still plausibly in flight, which is how
 * inventory — more than one video owed at a time — creeps in.
 */
export const AUTHORIZATION_LEAD_MS = 6 * 60 * 60 * 1000;

/** Sanity floor: never authorize so late that a full run + retry cannot fit. */
export const MINIMUM_LEAD_MS = PIPELINE_HARD_TIMEOUT_MS * 2;

export type TickOutcome =
  | "SKIPPED_DISABLED"
  | "SKIPPED_TOO_EARLY"
  | "SKIPPED_TOO_LATE"
  | "SKIPPED_ALREADY_OPEN"
  | "SKIPPED_INVALID_SLOT"
  | "WOULD_AUTHORIZE"
  | "AUTHORIZED"
  | "ALREADY_AUTHORIZED"
  | "ERROR";

export interface TickResult {
  channel: string;
  outcome: TickOutcome;
  reason: string;
  slot: Date | null;
  leadMs: number | null;
  cycle: ProductionCycle | null;
  /** True only when this tick actually wrote to the database. */
  mutated: boolean;
}

export interface SchedulerDeps {
  runnable(channel: string, now: Date): Promise<ProductionCycle | null>;
  nextSlot(channel: string, now: Date): Promise<Date>;
  authorize(channel: string, slot: Date): Promise<{ cycle: ProductionCycle; created: boolean }>;
  validate(slot: Date, channel: string): void;
}

export function realSchedulerDeps(): SchedulerDeps {
  return {
    runnable: currentRunnableCycle,
    nextSlot: nextCycleSlot,
    authorize: authorizeCycle,
    validate: assertValidSlot,
  };
}

/**
 * Whether the scheduler may write.
 *
 * Fail-closed and exact, matching MONITOR_MODE's convention: unset, empty, a
 * typo, "1", "yes" and "TRUE" all mean disabled. Only the exact literal enables
 * writes, so no plausible misconfiguration can accidentally arm it.
 */
export function isSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SCHEDULER_ENABLED ?? "").trim() === SCHEDULER_ENABLED_VALUE;
}

/**
 * One evaluation. Writes at most one row, and only when everything lines up.
 *
 * `dryRun` forces the read-only path regardless of the enable flag, so the
 * decision can be inspected in production without arming anything.
 */
export async function schedulerTick(
  channel: string,
  deps: SchedulerDeps,
  opts: { now?: Date; dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;
  const base = { channel, slot: null, leadMs: null, cycle: null, mutated: false } as const;

  if (!dryRun && !isSchedulerEnabled(env)) {
    return { ...base, outcome: "SKIPPED_DISABLED",
      reason: `SCHEDULER_ENABLED is not "${SCHEDULER_ENABLED_VALUE}" — no authorization written` };
  }

  let slot: Date;
  try {
    slot = await deps.nextSlot(channel, now);
  } catch (err) {
    return { ...base, outcome: "ERROR",
      reason: `could not compute next slot: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Revalidate what we just computed. The slot generator and the slot validator
  // are separate code paths, and a disagreement between them must fail closed
  // rather than authorize something the runtime would later refuse.
  try {
    deps.validate(slot, channel);
  } catch (err) {
    const code = err instanceof CycleError ? err.code : "CYCLE_SLOT_INVALID";
    return { ...base, slot, outcome: "SKIPPED_INVALID_SLOT",
      reason: `computed slot failed validation [${code}]: ` +
        `${err instanceof Error ? err.message : String(err)}` };
  }

  const leadMs = slot.getTime() - now.getTime();
  if (leadMs > AUTHORIZATION_LEAD_MS) {
    return { ...base, slot, leadMs, outcome: "SKIPPED_TOO_EARLY",
      reason: `next slot ${describeSlot(slot)} is ${Math.round(leadMs / 3600000)}h away; ` +
        `lead window opens at ${AUTHORIZATION_LEAD_MS / 3600000}h` };
  }
  if (leadMs < MINIMUM_LEAD_MS) {
    // Too close to publication for a run plus one retry to fit. Authorizing here
    // would buy a video that probably cannot be finished in time, and a missed
    // slot is a better outcome than a rushed one.
    return { ...base, slot, leadMs, outcome: "SKIPPED_TOO_LATE",
      reason: `only ${Math.round(leadMs / 60000)}min until ${describeSlot(slot)}; ` +
        `minimum is ${MINIMUM_LEAD_MS / 60000}min` };
  }

  const open = await deps.runnable(channel, now);
  if (open) {
    return { ...base, slot, leadMs, cycle: open, outcome: "SKIPPED_ALREADY_OPEN",
      reason: `cycle ${open.id} is already ${open.status} for ` +
        `${open.targetPublishSlot.toISOString()} — at most one video is ever owed` };
  }

  if (dryRun) {
    return { ...base, slot, leadMs, outcome: "WOULD_AUTHORIZE",
      reason: `would authorize one video for ${describeSlot(slot)}` };
  }

  const { cycle, created } = await deps.authorize(channel, slot);
  return {
    channel, slot, leadMs, cycle, mutated: created,
    outcome: created ? "AUTHORIZED" : "ALREADY_AUTHORIZED",
    reason: created
      ? `authorized cycle ${cycle.id} for ${describeSlot(slot)}`
      : `slot ${describeSlot(slot)} already had cycle ${cycle.id} — duplicate tick absorbed`,
  };
}
