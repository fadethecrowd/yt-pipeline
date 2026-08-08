/**
 * The monitor's master execution mode.
 *
 * `MONITOR_AI_ENABLED` was never a kill switch. It is consumed only by
 * `aiCallBudget`, so a monitor with AI disabled still started, ticked hourly,
 * read YouTube, scraped comments, ran lifecycle and Reddit logic, started a
 * Telegram bot that announced itself, and carried an executor holding
 * `videos.update` and `comments.insert`. Those write paths were unreachable
 * only because every decision that reaches them needs an AI call — a
 * behavioural accident, not a control.
 *
 * This is the actual control. It decides whether the monitor process does any
 * monitoring at all, and it is deliberately separate from the AI permission:
 * one answers "may this process act", the other "may it think".
 */

export type MonitorMode = "DISABLED" | "HEALTH_ONLY" | "ACTIVE";

export class MonitorModeError extends Error {
  constructor(readonly raw: string) {
    super(
      `MONITOR_MODE="${raw}" is not recognised. Expected exactly one of ` +
      `"disabled", "health_only", "active" — refusing to run.`,
    );
    this.name = "MonitorModeError";
  }
}

/**
 * Fail-closed. Absence means DISABLED, and anything unrecognised throws rather
 * than falling back to a mode that does work. An unknown value is a
 * misconfiguration, and the safe reading of a misconfiguration is "do nothing".
 *
 * Matching is exact and case-sensitive after trimming: "Active", "ACTIVE" and
 * "active " are not "active". A typo must not silently enable a live monitor.
 */
export function parseMonitorMode(raw: string | undefined): MonitorMode {
  if (raw === undefined || raw.trim() === "") return "DISABLED";
  const v = raw.trim();
  if (v === "disabled") return "DISABLED";
  if (v === "health_only") return "HEALTH_ONLY";
  if (v === "active") return "ACTIVE";
  throw new MonitorModeError(v);
}

/** Whether the mode permits any monitoring work at all. */
export function modePermitsWork(mode: MonitorMode): boolean {
  return mode !== "DISABLED";
}

/** Whether the mode permits the legacy write-capable machinery. */
export function modePermitsLegacy(mode: MonitorMode): boolean {
  return mode === "ACTIVE";
}
