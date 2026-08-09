import {
  schedulerTick, realSchedulerDeps, isSchedulerEnabled,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS, SCHEDULER_ENABLED_VALUE,
} from "@yt-pipeline/pipeline-core";

/**
 * Where the authorization scheduler actually runs.
 *
 * It lives in the monitor because the monitor is already the thing this system
 * has that runs continuously, one process per channel, with database access and
 * a proven fail-closed mode gate. Adding a new Railway service to hold a single
 * periodic INSERT would add infrastructure, a deploy target and a failure mode
 * without adding a capability.
 *
 * What it deliberately does NOT do is run a pipeline. The monitor imports no
 * pipeline code, so "the scheduler accidentally produced a video" is not a bug
 * that can be written here — the function to do it is not in scope.
 *
 * TWO INDEPENDENT GATES, both of which must be open:
 *
 *   MONITOR_MODE   — whether this process runs at all. `disabled` exits before
 *                    reaching any of this, so turning the monitor off also turns
 *                    authorization off. That coupling is one-directional and
 *                    fail-closed, which is the safe direction.
 *   SCHEDULER_ENABLED — whether the tick may write. Unset means no.
 *
 * The tick runs in HEALTH_ONLY as well as ACTIVE. Authorizing a cycle is not a
 * monitoring side effect: it makes no YouTube call, reads no comments and runs
 * no Claude prompt. Gating it behind full ACTIVE monitoring would mean
 * unattended production could not run without also re-enabling everything
 * MONITOR_MODE was introduced to switch off.
 */

export interface AuthorizationTickHandle {
  stop(): void;
  runNow(): Promise<void>;
}

/**
 * How often the tick evaluates policy.
 *
 * Frequency is not a schedule. The tick carries no notion of when a slot is;
 * it asks the timezone-aware policy every time and acts only inside the lead
 * window. Running every 15 minutes means the window is entered promptly without
 * the tick itself needing to be DST-correct.
 */
export const AUTHORIZATION_TICK_INTERVAL_MS = 15 * 60 * 1000;

export function startAuthorizationTick(
  channel: string,
  intervalMs: number = AUTHORIZATION_TICK_INTERVAL_MS,
): AuthorizationTickHandle {
  const label = `[scheduler:${channel}]`;
  const enabled = isSchedulerEnabled();

  console.log(
    `${label} SCHEDULER_ENABLED=${process.env.SCHEDULER_ENABLED ?? "<unset>"} → ` +
    `${enabled ? "ENABLED — may authorize production cycles" : "DISABLED — inert, no writes possible"}` +
    ` (required literal "${SCHEDULER_ENABLED_VALUE}")`,
  );
  console.log(
    `${label} lead window: authorize between ${MINIMUM_LEAD_MS / 3600000}h and ` +
    `${AUTHORIZATION_LEAD_MS / 3600000}h before a publication slot`,
  );

  const run = async (): Promise<void> => {
    try {
      const r = await schedulerTick(channel, realSchedulerDeps());
      // Every tick logs its decision, including the boring ones, so "why was
      // nothing authorized" is answerable from logs alone.
      const level = r.mutated ? "AUTHORIZED" : r.outcome;
      console.log(`${label} ${level}: ${r.reason}`);
    } catch (err) {
      console.error(`${label} tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  return { stop: () => clearInterval(timer), runNow: run };
}
