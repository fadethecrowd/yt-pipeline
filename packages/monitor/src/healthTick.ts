import {
  evaluateChannelHealth, GO_LIVE_GRACE_MS,
} from "./lib/videoHealth";
import {
  dedupeAlerts, newAlertState, formatResolved,
  type AlertState,
} from "./lib/alertDedup";
import type {
  HealthFinding, HealthReport, ScheduledVideo, YtView, RunView, BudgetView, PilotView,
} from "./lib/videoHealth";

/**
 * The HEALTH_ONLY execution path.
 *
 * Deliberately narrow. It does not call the legacy `tick()`, because that would
 * drag in metric polling, comment scraping, the decision engine, the executor,
 * lifecycle detection and Reddit posting — everything HEALTH_ONLY exists to
 * avoid. Instead it gathers exactly the reads the deterministic checks need and
 * evaluates them.
 *
 * The write boundary is structural, not a flag: this module imports no YouTube
 * client, no executor, no decision engine and no AI budget. Its only contact
 * with the outside world is through injected functions, and the injected
 * YouTube surface is a single read that returns privacy and publishAt. There is
 * no code path from here to `videos.update`, `comments.insert`, an upload, or a
 * pipeline trigger — not because a boolean forbids it, but because nothing
 * capable of it is reachable.
 */

export interface HealthDeps {
  /** Rows for THIS channel only, already scoped by the caller. */
  scheduledVideos(): Promise<ScheduledVideo[]>;
  /** Minimal read: does it exist, what privacy, what publishAt. */
  ytView(youtubeId: string): Promise<YtView | null>;
  unresolvedIntentCount(): Promise<number>;
  recentRuns(): Promise<RunView[]>;
  budgets(): Promise<BudgetView[]>;
  activeRunCount(): Promise<number>;
  pilots(): Promise<PilotView[]>;
  /** Injected so a test can prove nothing was ever sent. */
  sendAlert(text: string): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface HealthTickResult {
  report: HealthReport;
  alerted: boolean;
  /** Findings held back as unchanged repeats. */
  suppressed: number;
  /** Conditions that cleared since the last tick. */
  resolved: number;
  /** State to pass into the next tick. */
  alertState: AlertState;
}

/** Format a report for the existing alert transport. */
export function formatFindings(channel: string, findings: HealthFinding[]): string {
  const lines = findings.map((f) => `• [${f.severity}] ${f.code} — ${f.subject}: ${f.detail}`);
  return `Monitor health (${channel}) — ${findings.length} finding(s):\n${lines.join("\n")}`;
}

/**
 * One health evaluation. Reads, evaluates, and alerts only when a deterministic
 * finding exists. Silence is the expected outcome of a healthy channel.
 */
export async function runHealthTick(
  channel: string, deps: HealthDeps, graceMs: number = GO_LIVE_GRACE_MS,
  alertState: AlertState = newAlertState(),
): Promise<HealthTickResult> {
  const now = deps.now();
  // Every line of one tick carries the same id.
  //
  // Health exists only as log output — there is no durable heartbeat — so the
  // production readiness check has to reconstruct "what did the latest tick
  // say?" from these lines. Railway does not guarantee ordering within a batch
  // (a verdict has been observed printing before its own banner), and only the
  // banner carries a timestamp, so without an id the only way to associate a
  // finding with a tick is position, which is exactly what is unreliable.
  //
  // With an id the grouping is exact and order stops mattering.
  // Derived from the tick's own start instant rather than a random source: one
  // channel cannot start two ticks in the same millisecond, so it is unique
  // where it needs to be, and it keeps this module's imports limited to the
  // pure ./lib/ helpers — the boundary that stops the health path ever reaching
  // a writer.
  const tickId = now.getTime().toString(36);
  const say = (m: string) => deps.log(`[monitor:health] [tick ${tickId}] ${m}`);
  say(`═══ Health tick (${channel}) at ${now.toISOString()} ═══`);

  const videos = await deps.scheduledVideos();
  const scheduled: { video: ScheduledVideo; yt: YtView | null }[] = [];
  for (const v of videos) {
    // Only reach out for videos that actually claim a schedule.
    const yt = v.youtubeId ? await deps.ytView(v.youtubeId) : null;
    scheduled.push({ video: v, yt });
  }

  const report = evaluateChannelHealth({
    channel,
    scheduled,
    unresolvedIntents: await deps.unresolvedIntentCount(),
    runs: await deps.recentRuns(),
    budgets: await deps.budgets(),
    activeRuns: await deps.activeRunCount(),
    pilots: await deps.pilots(),
    now,
    graceMs,
  });

  // Log EVERY finding every tick — logs are cheap and are the audit trail.
  // Deduplication applies only to what gets pushed at a human.
  for (const f of report.findings) {
    say(`${f.severity} ${f.code} ${f.subject}: ${f.detail}`);
  }

  const d = dedupeAlerts({ findings: report.findings, state: alertState, now });

  if (d.resolved.length > 0) {
    say(`${d.resolved.length} condition(s) cleared`);
    await deps.sendAlert(formatResolved(channel, d.resolved));
  }
  if (d.notify.length > 0) {
    await deps.sendAlert(formatFindings(channel, d.notify));
  }
  if (d.suppressed.length > 0) {
    say(`${d.suppressed.length} unchanged finding(s) suppressed ` +
      "— already notified, awaiting the re-notify interval");
  }
  if (report.findings.length === 0) {
    say(`${channel}: healthy — ${scheduled.length} scheduled video(s) checked`);
  }

  return {
    report,
    alerted: d.notify.length > 0 || d.resolved.length > 0,
    suppressed: d.suppressed.length,
    resolved: d.resolved.length,
    alertState: d.nextState,
  };
}

/**
 * Run health ticks on an interval, with a single-flight guard.
 *
 * `setInterval` will happily start a second tick while the first is still
 * awaiting network reads, which would double the API traffic and interleave
 * alerts. The guard is the smallest thing that prevents that: one boolean, and
 * a skipped tick is logged rather than queued.
 */
export function startHealthLoop(
  channel: string, deps: HealthDeps, intervalMs: number,
): { stop(): void; runNow(): Promise<void> } {
  let inFlight = false;
  // Carried across ticks so a persistent condition is notified once rather than
  // every interval. Held in memory deliberately: the monitor runs continuously
  // for days, so the worst case is one alert per condition per deploy, and that
  // needs no schema change.
  let alertState: AlertState = newAlertState();

  const once = async (): Promise<void> => {
    if (inFlight) {
      deps.log(`[monitor:health] previous tick still running — skipping this interval`);
      return;
    }
    inFlight = true;
    try {
      const r = await runHealthTick(channel, deps, GO_LIVE_GRACE_MS, alertState);
      alertState = r.alertState;
    } catch (err) {
      // Surface, but never escalate into legacy behaviour.
      deps.log(`[monitor:health] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void once(); }, intervalMs);
  return { stop: () => clearInterval(timer), runNow: once };
}
