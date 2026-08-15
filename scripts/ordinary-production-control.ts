/**
 * Guarded one-shot ordinary production.
 *
 *   npx tsx scripts/ordinary-production-control.ts --channel ai-doom-scroll
 *   npx tsx scripts/ordinary-production-control.ts --channel wet-circuit --verify --run-id <id>
 *   ... --run --i-understand-this-creates-and-schedules-a-production-video
 *
 * There is no automatic recurring trigger for either channel: no Railway cron,
 * no schedule, no monitor hook, and a successful run exits 0 under an
 * ON_FAILURE restart policy. Ordinary production happens only when a container
 * starts — and with PIPELINE_MODE unlocked, ANY start (deploy, restart, env
 * change, infra event) would reach runPipeline and make a video. There is no
 * durable per-cycle authorisation to prevent that.
 *
 * So this does not unlock Railway. Both pipeline services stay permanently
 * PIPELINE_MODE=auth_check, and ordinary production is launched here instead:
 * one invocation, one candidate, one upload, then exit. An accidental container
 * restart still finds auth_check and does nothing. That property — not
 * convenience — is why this is a local control.
 *
 * This is GUARDED MANUAL production. It is not unattended production, and it
 * must not be described as such.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  prisma, disconnect, budgetReport, trancheReport, settleSlot, RunSummary,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import { nextPublishSlot, describeSlot } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";

export interface ChannelSpec {
  key: ChannelKey;
  model: "video" | "wcVideo";
  pilotId: string;
  service: string;
  monitorService: string;
  qualificationTarget: number;
}

export const SPECS: Record<ChannelKey, ChannelSpec> = {
  "ai-doom-scroll": {
    key: "ai-doom-scroll", model: "video", pilotId: "ai-doom-private-pilot-1",
    // Must equal the graduation control's target for this channel — this gate
    // asserts successCount === target, so a stale 3 here reads a legitimately
    // graduated 2/2 pilot as NOT_GRADUATED and blocks production entirely.
    // Kept honest by "the two controls agree on every channel's target".
    service: "yt-pipeline", monitorService: "monitor-ai-doom", qualificationTarget: 2,
  },
  "wet-circuit": {
    key: "wet-circuit", model: "wcVideo", pilotId: "wet-circuit-private-canary-1",
    service: "wc-pipeline", monitorService: "monitor-wc", qualificationTarget: 1,
  },
};

/** The canonical release every service must be running. */
export const CANONICAL_BRANCH = "main";

/**
 * Is the channel's monitor actually alive and reporting healthy?
 *
 * The monitor keeps no durable heartbeat — health exists only as log output —
 * so this reads its logs. The previous version took the LAST line containing
 * `[monitor:health]` and asked whether it said "healthy —". That was wrong in
 * three separate ways, and on 2026-08-15 it refused a production run against a
 * perfectly healthy monitor:
 *
 *   1. Both the tick BANNER and the healthy VERDICT carry the `[monitor:health]`
 *      prefix, and Railway does not guarantee ordering within a batch. The live
 *      logs showed the 00:18 verdict printed BEFORE its own banner, so the last
 *      matching line was the banner — which does not contain "healthy —".
 *   2. It was not channel-scoped, so another channel's monitor could answer for
 *      this one.
 *   3. It had no freshness check at all: a "healthy —" line from three days ago
 *      passed just as well as one from a minute ago. It could fail while healthy
 *      AND pass while dead.
 *
 * Now: find the newest tick banner FOR THIS CHANNEL, require it to be recent
 * relative to the monitor's own configured cadence, and require the window to
 * contain this channel's healthy verdict and no ALERT findings. Unknown state —
 * no banner, unparseable time, unknown cadence — is unhealthy, because "we
 * cannot tell whether anything is watching" is not a reason to spend money.
 */
export interface MonitorHealth { healthy: boolean; reason: string }

export function classifyMonitorHealth(input: {
  logs: string; channel: string; intervalMs: number | null; now: Date;
}): MonitorHealth {
  const { logs, channel, intervalMs, now } = input;
  if (!intervalMs || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { healthy: false, reason: "monitor poll interval is unknown — cannot judge freshness" };
  }
  const lines = logs.split("\n").filter((l) => l.includes("[monitor:health]"));
  if (lines.length === 0) {
    return { healthy: false, reason: "no [monitor:health] output in the retrieved log window" };
  }

  // Newest tick banner for THIS channel. Ordering is not trusted — every
  // timestamp is parsed and the maximum taken.
  const banner = new RegExp(
    `\\[monitor:health\\] ═══ Health tick \\(${channel}\\) at (\\S+) ═══`);
  let lastTick: Date | null = null;
  for (const l of lines) {
    const m = banner.exec(l);
    if (!m) continue;
    const t = new Date(m[1]!);
    if (Number.isNaN(t.getTime())) continue;
    if (!lastTick || t.getTime() > lastTick.getTime()) lastTick = t;
  }
  if (!lastTick) {
    return { healthy: false, reason: `no health tick for ${channel} in the retrieved log window` };
  }

  // One missed tick is tolerated; two means the monitor has stopped ticking.
  // Derived from the monitor's own POLL_INTERVAL_MS rather than a second magic
  // number living in this file.
  const maxAgeMs = intervalMs * 2;
  const ageMs = now.getTime() - lastTick.getTime();
  if (ageMs > maxAgeMs) {
    return {
      healthy: false,
      reason: `last health tick ${Math.round(ageMs / 60_000)} min ago exceeds ` +
        `${Math.round(maxAgeMs / 60_000)} min (2× the monitor's ${Math.round(intervalMs / 60_000)} min cadence)`,
    };
  }

  if (lines.some((l) => l.includes("[monitor:health] ALERT "))) {
    return { healthy: false, reason: "the monitor reported ALERT finding(s) in this window" };
  }
  if (!lines.some((l) => l.includes(`[monitor:health] ${channel}: healthy — `))) {
    return {
      healthy: false,
      reason: `no healthy verdict for ${channel} since the last tick ` +
        `(${lastTick.toISOString()}) — findings may be present`,
    };
  }
  return {
    healthy: true,
    reason: `last tick ${Math.round(ageMs / 60_000)} min ago, ${channel} healthy`,
  };
}

// ── Injected surface ──────────────────────────────────────────────────────

export interface RunRecord {
  id: string; channel: string; status: string; startTime: Date; endTime: Date | null;
  videoId?: string | null;
}
export interface VideoRow {
  id: string; youtubeId: string | null; status: string;
  scheduledAt: Date | null; createdAt: Date;
}

export interface OrdinaryDeps {
  readPilot(pilotId: string): Promise<PilotConfig | null>;
  readVars(service: string): Promise<Record<string, string>>;
  /** Deployed source for a service: branch + commit, or null for a CLI upload. */
  deployedSource(service: string): Promise<{ branch: string | null; commit: string | null }>;
  /** Monitor liveness for a channel, with the reason when it is not live. */
  monitorHealth(service: string, channel: string): Promise<MonitorHealth>;
  totalReserved(): Promise<number>;
  controlledLimits(): Promise<{ key: string; limit: number }[]>;
  activeRunCount(): Promise<number>;
  unresolvedIntentCount(): Promise<number>;
  futureScheduled(model: string, after: Date): Promise<Date[]>;
  /** Live finite production authorization for this channel, if any. */
  trancheState(channel: string): Promise<{
    phase: string; live: boolean; remaining: number; reason: string;
    shortsEnabled: boolean; expiresAt: Date | null;
  }>;
  runsSince(channel: string, since: Date): Promise<RunRecord[]>;
  rowsSince(model: string, since: Date): Promise<VideoRow[]>;
  rowById(model: string, id: string): Promise<VideoRow | null>;
  /** Records what became of a consumed attempt. Never returns capacity. */
  settleSlot(videoId: string, outcome: "SUCCESS" | "FAILED" | "AMBIGUOUS", detail: string): Promise<boolean>;
  /**
   * Calls the channel's real runPipeline exactly once, and returns the identity
   * of the execution it started.
   *
   * Returning the id is the whole point: the controller used to find "the
   * newest run row after a timestamp", which cannot see a run that failed
   * before any row was written, and could in principle attach to somebody
   * else's run. An execution now names itself.
   */
  invokePipeline(channel: ChannelKey): Promise<{ runId: string | null }>;
  /** The run with exactly this id, or null if none was persisted. */
  runById(runId: string): Promise<RunRecord | null>;
  now(): Date;
  log(line: string): void;
}

// ── CHECK ─────────────────────────────────────────────────────────────────

export type Phase =
  | "NOT_GRADUATED"
  | "RECONCILIATION_REQUIRED"
  | "RUN_IN_PROGRESS"
  | "BUDGET_NOT_CLEAN"
  | "MONITOR_UNHEALTHY"
  | "SOURCE_MISMATCH"
  | "SERVICE_UNLOCKED"
  | "NOT_AUTHORIZED"
  | "READY_FOR_ONE_SHOT";

export interface Check { ok: boolean; label: string; detail: string }
export interface CheckReport {
  checks: Check[]; phase: Phase; ready: boolean;
  targetSlot: Date | null; pilot: PilotConfig | null;
}

export async function evaluate(deps: OrdinaryDeps, spec: ChannelSpec): Promise<CheckReport> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });

  // ── Graduation ────────────────────────────────────────────────────
  const pilot = await deps.readPilot(spec.pilotId);
  add(!!pilot, "pilot record exists", pilot ? pilot.pilotId : "MISSING");
  const graduated = !!pilot && pilot.status === "COMPLETED"
    && pilot.channel === spec.key
    && pilot.successCount === spec.qualificationTarget
    && pilot.successVideoIds.length === spec.qualificationTarget;
  add(graduated, `pilot COMPLETED with ${spec.qualificationTarget} qualified video(s)`,
    pilot ? `${pilot.status} ${pilot.successCount}/${pilot.maxSuccesses} ` +
      `confirmed ${pilot.successVideoIds.length}` : "n/a");

  // ── Railway safety ────────────────────────────────────────────────
  const vars = await deps.readVars(spec.service);
  const locked = vars.PIPELINE_MODE === "auth_check";
  add(locked, "service stays locked (auth_check)", vars.PIPELINE_MODE ?? "<unset>");
  add(vars.DISABLE_ELEVEN === "true", "Railway DISABLE_ELEVEN=true (idle)",
    vars.DISABLE_ELEVEN ?? "<unset>");

  const src = await deps.deployedSource(spec.service);
  const canonical = src.branch === CANONICAL_BRANCH && !!src.commit;
  add(canonical, "deployed from canonical main",
    src.commit ? `${src.branch}@${src.commit.slice(0, 10)}` : "CLI upload / unknown");

  // ── Monitor ───────────────────────────────────────────────────────
  const mvars = await deps.readVars(spec.monitorService);
  const monMode = mvars.MONITOR_MODE === "health_only";
  add(monMode, "monitor MONITOR_MODE=health_only", mvars.MONITOR_MODE ?? "<unset>");
  const mon = await deps.monitorHealth(spec.monitorService, spec.key);
  add(mon.healthy, "monitor reports healthy", mon.reason);

  // ── Global ────────────────────────────────────────────────────────
  const reserved = await deps.totalReserved();
  const limits = await deps.controlledLimits();
  const active = await deps.activeRunCount();
  const unresolved = await deps.unresolvedIntentCount();
  add(reserved === 0, "zero reservations", String(reserved));
  const nz = limits.filter((l) => l.limit !== 0);
  add(nz.length === 0, "controlled budgets locked at 0",
    nz.length ? nz.map((l) => `${l.key}=${l.limit}`).join(" ") : "all 0");
  add(active === 0, "no active pipeline run", String(active));
  add(unresolved === 0, "no unresolved upload intent", String(unresolved));

  // ── Scheduler ─────────────────────────────────────────────────────
  const now = deps.now();
  const occupied = await deps.futureScheduled(spec.model, now);
  let targetSlot: Date | null = null;
  try {
    targetSlot = nextPublishSlot(now, { occupied });
    add(true, "next publication slot", describeSlot(targetSlot));
  } catch (err) {
    add(false, "next publication slot",
      err instanceof Error ? err.message : String(err));
  }
  add(true, "occupied future slots", String(occupied.length));

  // ── Finite spend authorization ────────────────────────────────────
  //
  // Graduation lets the channel produce; it does not pay for anything. A
  // tranche does, for a bounded number of attempts and a bounded time. No
  // tranche is NOT a fault — it is the resting state of a healthy production
  // channel, and it is reported as NOT_AUTHORIZED rather than as a failure.
  const tr = await deps.trancheState(spec.key);
  add(tr.live, "finite production authorization live",
    tr.live
      ? `${tr.remaining} attempt(s) remaining, Shorts ${tr.shortsEnabled ? "ON" : "off"}, ` +
        `expires ${tr.expiresAt?.toISOString() ?? "?"}`
      : tr.reason);

  // ── Phase ─────────────────────────────────────────────────────────
  let phase: Phase;
  if (unresolved > 0) phase = "RECONCILIATION_REQUIRED";
  else if (active > 0) phase = "RUN_IN_PROGRESS";
  else if (!graduated) phase = "NOT_GRADUATED";
  else if (!locked || vars.DISABLE_ELEVEN !== "true") phase = "SERVICE_UNLOCKED";
  else if (!canonical) phase = "SOURCE_MISMATCH";
  else if (!monMode || !mon.healthy) phase = "MONITOR_UNHEALTHY";
  else if (reserved !== 0 || nz.length > 0) phase = "BUDGET_NOT_CLEAN";
  else if (!tr.live) phase = "NOT_AUTHORIZED";
  else phase = checks.every((c) => c.ok) ? "READY_FOR_ONE_SHOT" : "NOT_GRADUATED";

  return { checks, phase, ready: phase === "READY_FOR_ONE_SHOT", targetSlot, pilot };
}

export async function doCheck(deps: OrdinaryDeps, spec: ChannelSpec): Promise<CheckReport> {
  const r = await evaluate(deps, spec);
  deps.log(`── ORDINARY PRODUCTION — CHECK (${spec.key})`);
  for (const c of r.checks) deps.log(`   ${c.ok ? "✓" : "✗"} ${c.label.padEnd(44)} ${c.detail}`);
  deps.log(`   target slot : ${r.targetSlot ? describeSlot(r.targetSlot) : "none"}`);
  deps.log(`   PHASE       : ${r.phase}`);
  if (r.phase === "MONITOR_UNHEALTHY") {
    const m = r.checks.find((c) => c.label === "monitor reports healthy");
    deps.log(`   → monitor: ${m?.detail ?? "unknown"}`);
  }
  if (r.phase === "NOT_AUTHORIZED") {
    deps.log("   → nothing may spend. Authorize a finite tranche first:");
    deps.log("     npx tsx scripts/production-tranche-control.ts --channel " +
      `${spec.key} --authorize --count 1 ` +
      "--i-understand-this-authorizes-real-production-spend");
  }
  return r;
}

// ── Local invocation environment ──────────────────────────────────────────

/**
 * The environment ONE ordinary run executes under.
 *
 * Scoped to this invocation and restored afterwards. Railway is never touched:
 * its PILOT_ID stays stored, its DISABLE_ELEVEN stays true, its PIPELINE_MODE
 * stays auth_check. Only this process's view changes, and only while the
 * pipeline is running.
 *
 * PILOT_ID is REMOVED for ordinary production. A completed pilot no longer
 * governs, but a stale PILOT_ID pointing at it makes `resolveAiDoomPilot` throw
 * PILOT_BINDING_STALE — correct fail-closed behaviour that must not be weakened
 * on the service. Unsetting it here, and only here, is the clean separation.
 */
export function buildRunEnv(spec: ChannelSpec): Record<string, string | undefined> {
  return {
    TEST_STAGE: "PRODUCTION",
    // Ordinary production narrates, renders and uploads for real.
    DISABLE_ELEVEN: "false",
    DRY_RUN: "false",
    // Absent, so no completed pilot is mistaken for a governing one.
    PILOT_ID: undefined,
  };
}

/** Apply an env patch, run, restore — even on throw. */
export async function withEnv<T>(
  patch: Record<string, string | undefined>, fn: () => Promise<T>,
): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── RUN ───────────────────────────────────────────────────────────────────

export type Outcome =
  | "SUCCESS_SCHEDULED"
  | "FAILED_BEFORE_SPEND"
  | "FAILED_AFTER_RESERVATION"
  | "QUALITY_FAILED"
  | "VISUAL_FEASIBILITY_FAILED"
  | "QA_FAILED"
  | "UPLOAD_AMBIGUOUS"
  | "OBSERVATION_FAILED"
  | "REFUSED";

export interface RunResult {
  outcome: Outcome;
  reason: string;
  runId: string | null;
  videoId: string | null;
  youtubeId: string | null;
  scheduledAt: Date | null;
  invocations: number;
  steps: string[];
}

export const RUN_PLAN = [
  "preflight", "watermark", "invoke-once", "identify-run", "identify-video", "classify",
] as const;

export async function doRun(
  deps: OrdinaryDeps, spec: ChannelSpec, confirmed: boolean,
): Promise<RunResult> {
  const steps: string[] = [];
  let invocations = 0;
  const no = (outcome: Outcome, reason: string): RunResult => ({
    outcome, reason, runId: null, videoId: null, youtubeId: null,
    scheduledAt: null, invocations, steps,
  });

  if (!confirmed) {
    return no("REFUSED", "--i-understand-this-creates-and-schedules-a-production-video is required");
  }

  steps.push("preflight");
  const pre = await evaluate(deps, spec);
  if (pre.phase !== "READY_FOR_ONE_SHOT") {
    return no("REFUSED", `phase is ${pre.phase}, expected READY_FOR_ONE_SHOT`);
  }
  deps.log(`   ✓ pre-flight clean — target slot ${describeSlot(pre.targetSlot!)}`);

  steps.push("watermark");
  const watermark = deps.now();

  // ── The single invocation ─────────────────────────────────────────
  steps.push("invoke-once");
  let threw: string | null = null;
  let startedRunId: string | null = null;
  try {
    await withEnv(buildRunEnv(spec), async () => {
      invocations++;
      const started = await deps.invokePipeline(spec.key);
      startedRunId = started.runId;
    });
  } catch (err) {
    // Never retried. One authorisation, one attempt.
    threw = err instanceof Error ? err.message : String(err);
    deps.log(`   ✗ pipeline threw: ${threw}`);
  }

  // ── Identity ──────────────────────────────────────────────────────
  //
  // By exact id first. "Newest row after a timestamp" was never a correlation,
  // only a guess that usually happened to be right — and on 2026-08-14 it was
  // wrong in the way that matters: the pipeline created a candidate and failed
  // with a known reason, no run row existed to find, and the controller
  // reported OBSERVATION_FAILED as though nothing had been observed at all.
  //
  // The watermark scan is kept as a fallback for the case the id genuinely
  // never reached the database (persistence is deliberately non-fatal), so a
  // run that happened is still noticed rather than silently dropped.
  steps.push("identify-run");
  let run: RunRecord | null = startedRunId ? await deps.runById(startedRunId) : null;
  if (!run) {
    const runs = await deps.runsSince(spec.key, watermark);
    run = runs.length ? runs[runs.length - 1]! : null;
  }

  steps.push("identify-video");
  // The run names its own candidate. Falling back to "newest row" only when it
  // does not, which is how an early failure before setVideoId still resolves.
  let video: VideoRow | null = run?.videoId ? await deps.rowById(spec.model, run.videoId) : null;
  if (!video) {
    const rows = await deps.rowsSince(spec.model, watermark);
    video = rows.length ? rows[rows.length - 1]! : null;
  }

  steps.push("classify");
  const unresolved = await deps.unresolvedIntentCount();
  const reserved = await deps.totalReserved();

  const base = {
    runId: run?.id ?? null,
    videoId: video?.id ?? null,
    youtubeId: video?.youtubeId ?? null,
    scheduledAt: video?.scheduledAt ?? null,
    invocations, steps,
  };

  // ── Settle the tranche slot from the CLASSIFIED outcome ───────────
  //
  // Never from `run.status`: a completed pilot-style WARNING is a success, and
  // "no outstanding reservation" has already been shown not to mean "no spend".
  // Anything we cannot classify confidently settles to RECONCILIATION_REQUIRED,
  // which leaves the attempt consumed — an ambiguous outcome must never quietly
  // return capacity to the pool.
  const settle = async (o: "SUCCESS" | "FAILED" | "AMBIGUOUS", why: string) => {
    if (video?.id) await deps.settleSlot(video.id, o, why);
  };

  if (unresolved > 0) {
    await settle("AMBIGUOUS", `${unresolved} unresolved upload intent(s)`);
    return { ...base, outcome: "UPLOAD_AMBIGUOUS",
      reason: `${unresolved} unresolved upload intent(s) — reconcile before any future run` };
  }
  if (reserved > 0) {
    await settle("AMBIGUOUS", `${reserved} chars still reserved`);
    return { ...base, outcome: "FAILED_AFTER_RESERVATION",
      reason: `${reserved} chars still reserved — settle before any future run` };
  }
  if (threw) {
    await settle("FAILED", `pipeline threw: ${threw}`);
    return { ...base, outcome: "FAILED_BEFORE_SPEND",
      reason: `pipeline threw with no reservation and no intent outstanding: ${threw}` };
  }
  if (!run) {
    await settle("AMBIGUOUS", "no pipeline run appeared after the watermark");
    return { ...base, outcome: "OBSERVATION_FAILED",
      reason: "no pipeline run appeared after the watermark" };
  }
  // WARNING is a finished run, not a stopped one. `RunSummary.verifyOutputs`
  // emits it when every stage COMPLETED but an expected output is missing, so
  // an upload that simply produced no Short lands here. Treating only SUCCESS
  // as "finished" is the same defect fixed for the pilot controller in
  // e1dc803, where a completed upload was reported as FAILED_BEFORE_SPEND.
  const COMPLETED = ["SUCCESS", "WARNING"];
  if (COMPLETED.includes(run.status) && video?.youtubeId && video.scheduledAt) {
    await settle("SUCCESS", `uploaded ${video.youtubeId}, scheduled`);
    return { ...base, outcome: "SUCCESS_SCHEDULED",
      reason: `run ${run.status} — scheduled for ${video.scheduledAt.toISOString()} ` +
        `(${describeSlot(video.scheduledAt)})` };
  }
  // Never infer "no spend" from status while a video exists on the channel.
  // A youtubeId is evidence that narration was bought, a render happened and
  // an upload completed; whatever the run status says, "never bought a thing"
  // is the one thing it cannot mean.
  if (video?.youtubeId) {
    await settle("AMBIGUOUS", `run ${run.status} but youtubeId ${video.youtubeId} exists`);
    return { ...base, outcome: "UPLOAD_AMBIGUOUS",
      reason: `run ${run.status} but video ${video.id} carries youtubeId ${video.youtubeId}` +
        `${video.scheduledAt ? "" : " with no scheduledAt"} — reconcile before any future run` };
  }
  // A terminal non-success with clean budget, no intent and no video never
  // bought a thing.
  const status = video?.status ?? run.status;
  const outcome: Outcome =
    status === "QUALITY_FAILED" ? "QUALITY_FAILED" : "FAILED_BEFORE_SPEND";
  await settle("FAILED", `run ${run.status}, video status ${status}`);
  return { ...base, outcome, reason: `run ${run.status}, video status ${status}` };
}

// ── VERIFY ────────────────────────────────────────────────────────────────

export interface VerifyResult {
  found: boolean; channel: string; videoId: string | null; youtubeId: string | null;
  status: string | null; scheduledAt: Date | null; consistent: boolean; detail: string;
}

export async function doVerify(
  deps: OrdinaryDeps, spec: ChannelSpec, videoId: string,
): Promise<VerifyResult> {
  const row = await deps.rowById(spec.model, videoId);
  if (!row) {
    return { found: false, channel: spec.key, videoId: null, youtubeId: null,
      status: null, scheduledAt: null, consistent: false, detail: "no such row" };
  }
  const consistent = !!row.youtubeId && !!row.scheduledAt && row.status === "UPLOADED";
  deps.log(`   video ${row.id}  yt=${row.youtubeId ?? "none"}  status=${row.status}`);
  deps.log(`   scheduledAt ${row.scheduledAt?.toISOString() ?? "null"}`);
  deps.log(consistent ? "   ✓ consistent" : "   ✗ INCOMPLETE — reconciliation may be required");
  return { found: true, channel: spec.key, videoId: row.id, youtubeId: row.youtubeId,
    status: row.status, scheduledAt: row.scheduledAt, consistent,
    detail: consistent ? "uploaded and scheduled" : "missing youtubeId, schedule or UPLOADED status" };
}

// ── Real dependencies ─────────────────────────────────────────────────────

async function railway(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("railway", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export function realDeps(): OrdinaryDeps {
  const models = prisma as unknown as Record<string, {
    findMany(a: unknown): Promise<VideoRow[]>;
    findUnique(a: unknown): Promise<VideoRow | null>;
  }>;
  const pilots = (prisma as never as { productionPilot: any }).productionPilot;
  return {
    readPilot: (pilotId) => pilots.findUnique({ where: { pilotId } }),
    async readVars(service) {
      const out = await railway(["variables", "--service", service, "--environment", "production", "--kv"]);
      const kv: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return kv;
    },
    async deployedSource(service) {
      const out = await railway(["status", "--json"]);
      const d = JSON.parse(out);
      for (const e of d.environments.edges) {
        for (const si of e.node.serviceInstances.edges) {
          if (si.node.serviceName !== service) continue;
          const m = (si.node.latestDeployment ?? {}).meta ?? {};
          return { branch: m.branch ?? null, commit: m.commitHash ?? null };
        }
      }
      return { branch: null, commit: null };
    },
    async monitorHealth(service, channel) {
      const logs = await railway(["logs", "--service", service, "--environment", "production"]);
      // The threshold comes from the monitor's OWN configured cadence, read from
      // the service it belongs to, so the two cannot drift apart.
      let intervalMs: number | null = null;
      try {
        const vars = JSON.parse(await railway(["variables", "--service", service, "--json"]));
        const raw = Number((vars as Record<string, string>).POLL_INTERVAL_MS);
        intervalMs = Number.isFinite(raw) && raw > 0 ? raw : null;
      } catch { intervalMs = null; }
      return classifyMonitorHealth({ logs, channel, intervalMs, now: new Date() });
    },
    async totalReserved() { return (await budgetReport()).totalReserved; },
    async controlledLimits() {
      const rep = await budgetReport();
      return (rep.rows as { channel: string; stage: string; limit: number }[])
        .filter((r) => r.stage !== "DIAGNOSTIC")
        .map((r) => ({ key: `${r.channel}/${r.stage}`, limit: r.limit }));
    },
    activeRunCount: () => prisma.pipelineRun.count({ where: { endTime: null } }),
    unresolvedIntentCount: () => prisma.uploadIntent.count({
      where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
    }),
    async trancheState(channel) {
      const r = await trancheReport(channel);
      return {
        phase: r.phase, live: r.live, remaining: r.remaining, reason: r.reason,
        shortsEnabled: r.tranche?.shortsEnabled ?? false,
        expiresAt: r.tranche?.expiresAt ?? null,
      };
    },
    async futureScheduled(model, after) {
      const rows = await models[model]!.findMany({
        where: { scheduledAt: { gt: after } }, select: { scheduledAt: true },
      }) as unknown as { scheduledAt: Date | null }[];
      return rows.map((r) => r.scheduledAt).filter((d): d is Date => d !== null);
    },
    async runsSince(channel, since) {
      return prisma.pipelineRun.findMany({
        where: { channel, startTime: { gte: since } },
        orderBy: { startTime: "desc" },
        select: { id: true, channel: true, status: true, startTime: true, endTime: true, videoId: true },
      }) as unknown as RunRecord[];
    },
    async rowsSince(model, since) {
      return models[model]!.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        select: { id: true, youtubeId: true, status: true, scheduledAt: true, createdAt: true },
      });
    },
    rowById: (model, id) => models[model]!.findUnique({
      where: { id },
      select: { id: true, youtubeId: true, status: true, scheduledAt: true, createdAt: true },
    }),
    settleSlot: (videoId, outcome, detail) => settleSlot(videoId, outcome, detail),
    async invokePipeline(channel) {
      // A RunSummary is what gives an execution its identity: it mints `runId`
      // at construction, and everything downstream — the production tranche
      // claim, the narration window, this controller's own correlation — is
      // scoped to that id.
      //
      // This used to call `runPipeline()` bare. `src/index.ts`, the ordinary
      // container entry point, has always constructed one; the controller
      // bypasses that entry point to keep Railway locked, and inherited none of
      // it. So `summary?.runId` was undefined, `claimProductionAttempt`
      // correctly refused a candidate with no run identity, and no run row was
      // ever persisted for the controller to find.
      //
      // Persisted in a `finally`, mirroring the entry point, so a run that
      // fails early still leaves exactly one terminal row.
      const runMode = process.env.DISABLE_ELEVEN === "true" ? "DRY_RUN" : "LIVE";
      const summary = new RunSummary(channel, runMode);
      try {
        if (channel === "ai-doom-scroll") {
          const { runPipeline } = await import("../src/pipeline");
          await runPipeline(summary);
        } else {
          const { runPipeline } = await import("../packages/wc-pipeline/src/pipeline");
          await runPipeline(summary);
        }
      } catch (err) {
        summary.markFailed("__controller__", err);
        throw err;
      } finally {
        await summary.persist();
      }
      return { runId: summary.runId };
    },
    async runById(runId) {
      return prisma.pipelineRun.findUnique({
        where: { id: runId },
        select: { id: true, channel: true, status: true, startTime: true, endTime: true, videoId: true },
      }) as unknown as RunRecord | null;
    },
    now: () => new Date(),
    log: (l) => console.log(l),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────

export function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

export function selectedMode(argv: string[]): "RUN" | "VERIFY" | "CHECK" | "AMBIGUOUS" {
  const picked = [argv.includes("--run") && "RUN", argv.includes("--verify") && "VERIFY"]
    .filter(Boolean) as string[];
  if (picked.length > 1) return "AMBIGUOUS";
  return (picked[0] as never) ?? "CHECK";
}


/**
 * Reject anything not in the flag surface.
 *
 * Every mode here falls through to a read-only CHECK when no mode flag matches,
 * which is safe but silent: a mistyped `--arm` produced a clean CHECK report
 * that an operator could easily read as "it armed". Refusing the command is the
 * only outcome that cannot be misread.
 */
function assertKnownFlags(argv: string[], known: string[]): boolean {
  const unknown = argv.slice(2).filter((a) => a.startsWith("--") && !known.includes(a));
  if (unknown.length === 0) return true;
  console.error(`\u2717 unrecognised flag(s): ${unknown.join(" ")}`);
  console.error(`  known flags: ${known.join(" ")}`);
  process.exitCode = 2;
  return false;
}

async function main(): Promise<void> {
  if (!assertKnownFlags(process.argv, ["--channel", "--i-understand-this-creates-and-schedules-a-production-video", "--run", "--verify", "--video"])) return;
  const mode = selectedMode(process.argv);
  if (mode === "AMBIGUOUS") { console.error("✗ more than one mode flag"); process.exitCode = 2; return; }
  const channel = argValue(process.argv, "--channel") as ChannelKey | null;
  if (!channel || !SPECS[channel]) {
    console.error("✗ --channel must be ai-doom-scroll or wet-circuit"); process.exitCode = 2; return;
  }
  const spec = SPECS[channel];
  const deps = realDeps();

  if (mode === "CHECK") { await doCheck(deps, spec); return; }
  if (mode === "VERIFY") {
    const id = argValue(process.argv, "--video");
    if (!id) { console.error("✗ --video <row id> is required for VERIFY"); process.exitCode = 2; return; }
    const r = await doVerify(deps, spec, id);
    if (!r.consistent) process.exitCode = 1;
    return;
  }
  const r = await doRun(deps, spec,
    process.argv.includes("--i-understand-this-creates-and-schedules-a-production-video"));
  console.log(`\n  OUTCOME : ${r.outcome}\n  reason  : ${r.reason}`);
  console.log(`  run     : ${r.runId ?? "n/a"}\n  video   : ${r.videoId ?? "n/a"}`);
  console.log(`  youtube : ${r.youtubeId ?? "n/a"}\n  schedule: ${r.scheduledAt?.toISOString() ?? "n/a"}`);
  console.log(`  pipeline invocations: ${r.invocations}`);
  if (r.outcome !== "SUCCESS_SCHEDULED") process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("ordinary-production-control.ts") ||
  process.argv[1]?.endsWith("ordinary-production-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
