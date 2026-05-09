import { env } from "../config";

let callsToday = 0;
let budgetDateUTC = new Date().toISOString().slice(0, 10);

function resetIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDateUTC) {
    console.log(
      `[aiCallBudget] New UTC day — daily Claude call counter reset (was ${callsToday})`,
    );
    callsToday = 0;
    budgetDateUTC = today;
  }
}

/**
 * Check AI kill-switch and daily call budget before making a Claude call.
 * Increments the counter and returns true if the call is allowed.
 * Logs clearly whenever a call is blocked.
 */
export function acquireAICall(caller: string): boolean {
  const config = env();

  if (!config.MONITOR_AI_ENABLED) {
    console.log(
      `[monitor] AI disabled (MONITOR_AI_ENABLED=false) — skipping Claude call [${caller}]`,
    );
    return false;
  }

  resetIfNewDay();

  const limit = config.MONITOR_AI_DAILY_CALL_LIMIT;
  if (callsToday >= limit) {
    console.warn(
      `[monitor] Daily Claude call limit reached (${callsToday}/${limit}) — skipping [${caller}]`,
    );
    return false;
  }

  callsToday++;
  console.log(`[aiCallBudget] Claude call ${callsToday}/${limit} today [${caller}]`);
  return true;
}
