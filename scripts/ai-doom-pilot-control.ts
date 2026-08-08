/**
 * AI Doom private-pilot control.
 *
 *   npx tsx scripts/ai-doom-pilot-control.ts                 # CHECK (default)
 *   npx tsx scripts/ai-doom-pilot-control.ts --arm  --i-understand-this-activates-the-pilot
 *   npx tsx scripts/ai-doom-pilot-control.ts --run  --i-understand-this-spends-credits
 *   npx tsx scripts/ai-doom-pilot-control.ts --relock
 *   npx tsx scripts/ai-doom-pilot-control.ts --advance-cap --i-have-reviewed-the-previous-video
 *
 * CHECK is read-only and is the default. Every other mode requires its own
 * explicit flag AND its own acknowledgement flag, so no accidental invocation
 * can mutate anything or spend. No mode infers intent from a missing flag.
 *
 * Why this exists: activating the pilot by hand meant coordinating a Railway
 * variable stage, a direct SQL activation, removal of the auth_check lock,
 * watching for exactly one run, an immediate relock, and restoration of
 * DISABLE_ELEVEN — six steps where a missed one leaves production unlocked.
 * The sequence is the control, so the sequence is what gets encoded.
 *
 * The one genuinely irreversible moment is removing the auth_check lock. From
 * that point RUN is wrapped in try/finally and always attempts to relock, and
 * it reports loudly when the relock itself did not take.
 *
 * LOCAL ONLY. Nothing under src/ imports this module, so no container start can
 * reach it. Wet Circuit is not referenced: it has its own tracked canary
 * control and neither tool imports the other.
 */
import { VideoStatus } from "@prisma/client";
import {
  prisma, disconnect, budgetReport,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import { evaluateAiDoomPilotWindow } from "../src/pilotBinding";
import "dotenv/config";

// ── Identity ──────────────────────────────────────────────────────────────

export const SERVICE = "yt-pipeline";
export const ENVIRONMENT = "production";
export const PILOT_ID = "ai-doom-private-pilot-1";
export const CHANNEL = "ai-doom-scroll";

/** The value that locks the service. Anything else unlocks it. */
export const LOCK_VALUE = "auth_check";
/** What RUN sets to unlock — a plain value, so relock is a symmetric `set`. */
export const UNLOCK_VALUE = "production";

/** Highest cap the progressive review process may ever reach. */
export const MAX_CAP = 3;

// ── Injected surface ──────────────────────────────────────────────────────
//
// Everything that touches Railway, the database, the clock or sleeping is
// injected, so tests prove the commands and their ORDER without executing any
// of them.

export interface RunRecord {
  id: string;
  channel: string;
  status: string;
  startTime: Date;
  endTime: Date | null;
}

export interface ControlDeps {
  readVars(service: string): Promise<Record<string, string>>;
  /** One invocation, one redeploy — unless skipDeploys stages it silently. */
  setVars(service: string, kv: Record<string, string>, opts: { skipDeploys: boolean }): Promise<void>;
  readPilot(pilotId: string): Promise<PilotConfig | null>;
  /** Compare-and-set PREPARED → ACTIVE. Returns rows affected. */
  activatePilot(pilotId: string): Promise<number>;
  /** Compare-and-set maxSuccesses. Returns rows affected. */
  setMaxSuccesses(pilotId: string, from: number, to: number): Promise<number>;
  totalReserved(): Promise<number>;
  controlledLimits(): Promise<{ key: string; limit: number }[]>;
  activeRunCount(): Promise<number>;
  unresolvedIntentCount(): Promise<number>;
  /** Runs for the channel started at or after `since`, newest first. */
  runsSince(channel: string, since: Date): Promise<RunRecord[]>;
  videoById(id: string): Promise<{ id: string; youtubeId: string | null; status: string; scheduledAt: Date | null } | null>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

// ── State ─────────────────────────────────────────────────────────────────

export interface ControlState {
  vars: Record<string, string>;
  pilot: PilotConfig | null;
  reserved: number;
  limits: { key: string; limit: number }[];
  activeRuns: number;
  unresolvedIntents: number;
  now: Date;
}

export async function gatherState(deps: ControlDeps): Promise<ControlState> {
  return {
    vars: await deps.readVars(SERVICE),
    pilot: await deps.readPilot(PILOT_ID),
    reserved: await deps.totalReserved(),
    limits: await deps.controlledLimits(),
    activeRuns: await deps.activeRunCount(),
    unresolvedIntents: await deps.unresolvedIntentCount(),
    now: deps.now(),
  };
}

export interface Check { ok: boolean; label: string; detail: string }

export type Phase =
  | "PILOT_MISSING"
  | "CONFIG_INVALID"
  | "RECONCILIATION_REQUIRED"
  | "RUN_IN_PROGRESS"
  | "PREPARED_FOR_ARM"
  | "ARMED_FOR_RUN"
  | "CAP_EXHAUSTED_REVIEW_REQUIRED"
  | "QUALIFICATION_COMPLETE_REVIEW_REQUIRED"
  | "PILOT_COMPLETE";

/**
 * Static readiness — everything except the wall clock.
 *
 * The window is evaluated separately and deliberately excluded from these
 * checks. Running CHECK on a Saturday must not make the configuration look
 * broken; it is correct configuration that simply may not run right now.
 */
export function staticChecks(state: ControlState): Check[] {
  const c: Check[] = [];
  const v = state.vars;
  const add = (ok: boolean, label: string, detail: string) => c.push({ ok, label, detail });

  add(v.PILOT_ID === PILOT_ID, "PILOT_ID bound exactly", v.PILOT_ID ?? "<unset>");
  add(v.TEST_STAGE === "PRODUCTION", "TEST_STAGE=PRODUCTION", v.TEST_STAGE ?? "<unset>");
  add(v.PIPELINE_MODE === LOCK_VALUE, "service locked (auth_check)", v.PIPELINE_MODE ?? "<unset>");
  add(v.DISABLE_ELEVEN === "true", "DISABLE_ELEVEN=true", v.DISABLE_ELEVEN ?? "<unset>");

  const p = state.pilot;
  add(!!p, "pilot row exists", p ? p.pilotId : "MISSING");
  if (p) {
    add(p.channel === CHANNEL, "pilot bound to the AI Doom channel", `${p.channel}`);
    add(p.privacyStatus === "private", "PRIVATE", p.privacyStatus);
    add(!p.allowPublishAt, "publishAt forbidden", String(p.allowPublishAt));
    add(!p.shortsEnabled, "Shorts disabled", String(p.shortsEnabled));
    add(p.requireFeasibility && p.requireGuardedUpload,
      "feasibility + guarded upload required", "both true");
    add(p.maxSuccesses <= MAX_CAP, `cap within ${MAX_CAP}`, `${p.successCount}/${p.maxSuccesses}`);
    add(p.successVideoIds.length <= p.successCount,
      "confirmed successes consistent",
      `${p.successVideoIds.length} confirmed vs ${p.successCount} claimed`);
  }

  add(state.reserved === 0, "zero reservations", String(state.reserved));
  const nonZero = state.limits.filter((l) => l.limit !== 0);
  add(nonZero.length === 0, "controlled budgets locked at 0",
    nonZero.length ? nonZero.map((l) => `${l.key}=${l.limit}`).join(" ") : "all 0");
  add(state.activeRuns === 0, "no active pipeline run", String(state.activeRuns));
  add(state.unresolvedIntents === 0, "no unresolved upload intent", String(state.unresolvedIntents));
  return c;
}

/** Precise phase, never a vague "ready". */
export function classifyPhase(state: ControlState): Phase {
  const p = state.pilot;
  if (!p) return "PILOT_MISSING";
  if (state.unresolvedIntents > 0) return "RECONCILIATION_REQUIRED";
  if (state.activeRuns > 0) return "RUN_IN_PROGRESS";
  if (!staticChecks(state).every((x) => x.ok)) return "CONFIG_INVALID";

  const remaining = Math.max(0, p.maxSuccesses - p.successCount);
  if (p.status === "PREPARED") {
    return remaining > 0 ? "PREPARED_FOR_ARM" : "CONFIG_INVALID";
  }
  if (p.status === "ACTIVE") {
    if (remaining > 0) return "ARMED_FOR_RUN";
    // Ceiling consumed. At the full qualification target the remaining action is
    // final human acceptance, not another cap advance — the pilot stays ACTIVE
    // until a person completes it through the graduation control.
    return p.successCount >= MAX_CAP
      ? "QUALIFICATION_COMPLETE_REVIEW_REQUIRED"
      : "CAP_EXHAUSTED_REVIEW_REQUIRED";
  }
  if (p.status === "COMPLETED") return "PILOT_COMPLETE";
  return "CONFIG_INVALID";
}

export function windowDecision(state: ControlState) {
  if (!state.pilot) return { allowed: false, nowLocal: state.now.toISOString(), reason: "no pilot" };
  return evaluateAiDoomPilotWindow(state.now, state.pilot);
}

// ── CHECK ─────────────────────────────────────────────────────────────────

export interface CheckReport {
  checks: Check[];
  staticReady: boolean;
  window: { allowed: boolean; nowLocal: string; reason: string };
  phase: Phase;
  remainingSlots: number;
}

export function buildCheckReport(state: ControlState): CheckReport {
  const checks = staticChecks(state);
  const p = state.pilot;
  return {
    checks,
    staticReady: checks.every((c) => c.ok),
    window: windowDecision(state),
    phase: classifyPhase(state),
    remainingSlots: p ? Math.max(0, p.maxSuccesses - p.successCount) : 0,
  };
}

export async function doCheck(deps: ControlDeps): Promise<CheckReport> {
  const state = await gatherState(deps);
  const r = buildCheckReport(state);
  deps.log(`── AI DOOM PILOT CONTROL — CHECK`);
  deps.log(`   service ${SERVICE}/${ENVIRONMENT}   pilot ${PILOT_ID}`);
  for (const c of r.checks) deps.log(`   ${c.ok ? "✓" : "✗"} ${c.label.padEnd(38)} ${c.detail}`);
  deps.log(`   STATIC READINESS : ${r.staticReady ? "PASS" : "FAIL"} (${r.checks.filter((c) => c.ok).length}/${r.checks.length})`);
  deps.log(`   EXECUTION WINDOW : ${r.window.allowed ? "INSIDE" : "OUTSIDE"} — ${r.window.reason}`);
  deps.log(`   now (local)      : ${r.window.nowLocal}`);
  deps.log(`   remaining slots  : ${r.remainingSlots}`);
  deps.log(`   PHASE            : ${r.phase}`);
  return r;
}

// ── ARM ───────────────────────────────────────────────────────────────────

export interface ArmResult { armed: boolean; reason: string; rowsAffected: number }

/**
 * Durable activation only: PREPARED → ACTIVE with activatedAt.
 *
 * Changes no Railway variable, restarts nothing, opens no budget, creates no
 * candidate and runs no pipeline. It is deliberately a separate invocation from
 * RUN so the armed state is reviewable before anything is spent.
 */
export async function doArm(deps: ControlDeps, confirmed: boolean): Promise<ArmResult> {
  if (!confirmed) {
    return { armed: false, reason: "ARM requires --i-understand-this-activates-the-pilot", rowsAffected: 0 };
  }
  const state = await gatherState(deps);
  const r = buildCheckReport(state);
  const p = state.pilot;

  if (!r.staticReady) return { armed: false, reason: `pre-flight failed: ${r.phase}`, rowsAffected: 0 };
  if (!p) return { armed: false, reason: "pilot row missing", rowsAffected: 0 };
  if (r.phase !== "PREPARED_FOR_ARM") {
    return { armed: false, reason: `phase is ${r.phase}, expected PREPARED_FOR_ARM`, rowsAffected: 0 };
  }
  if (p.successCount !== 0 || p.activatedAt) {
    return { armed: false, reason: "pilot has already been used or activated", rowsAffected: 0 };
  }
  // First run must go out under a cap of exactly one, so a human sees video #1
  // before video #2 becomes possible. A 0/3 pilot is refused here rather than
  // silently arming three.
  if (p.maxSuccesses !== 1) {
    return {
      armed: false,
      reason: `maxSuccesses is ${p.maxSuccesses}; first ARM requires 1 so review is forced between videos`,
      rowsAffected: 0,
    };
  }
  if (!r.window.allowed) {
    return { armed: false, reason: `outside the execution window — ${r.window.reason}`, rowsAffected: 0 };
  }

  const rows = await deps.activatePilot(PILOT_ID);
  if (rows !== 1) {
    return { armed: false, reason: `activation matched ${rows} rows, expected 1`, rowsAffected: rows };
  }
  deps.log(`   ✓ pilot ${PILOT_ID} PREPARED → ACTIVE`);
  return { armed: true, reason: "armed", rowsAffected: 1 };
}

// ── RUN ───────────────────────────────────────────────────────────────────

export type RunOutcome =
  | "SUCCESS"
  | "FAILED_BEFORE_SPEND"
  | "FAILED_AFTER_RESERVATION"
  | "UPLOAD_AMBIGUOUS"
  | "QA_FAILED"
  | "OBSERVATION_FAILED"
  | "REFUSED";

export interface RunResult {
  outcome: RunOutcome;
  reason: string;
  runId: string | null;
  relocked: boolean;
  relockError: string | null;
  steps: string[];
}

/** The ordered plan, pure so tests can assert it without executing anything. */
export const RUN_PLAN = [
  "preflight",
  "stage:DISABLE_ELEVEN=false(--skip-deploys)",
  "verify-staged",
  "watermark",
  "unlock:PIPELINE_MODE=production",
  "observe",
  "relock:PIPELINE_MODE=auth_check+DISABLE_ELEVEN=true",
  "verify-relock",
] as const;

const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 160; // ~40 minutes; the service's own hard timeout is 30.

export async function doRun(deps: ControlDeps, confirmed: boolean): Promise<RunResult> {
  const steps: string[] = [];
  const fail = (outcome: RunOutcome, reason: string): RunResult =>
    ({ outcome, reason, runId: null, relocked: false, relockError: null, steps });

  if (!confirmed) return fail("REFUSED", "RUN requires --i-understand-this-spends-credits");

  // ── preflight ───────────────────────────────────────────────────────
  steps.push("preflight");
  const state = await gatherState(deps);
  const r = buildCheckReport(state);
  if (!r.staticReady) return fail("REFUSED", `pre-flight failed: ${r.phase}`);
  if (r.phase !== "ARMED_FOR_RUN") return fail("REFUSED", `phase is ${r.phase}, expected ARMED_FOR_RUN`);
  if (r.remainingSlots !== 1) return fail("REFUSED", `remainingSlots is ${r.remainingSlots}, expected exactly 1`);
  if (!r.window.allowed) return fail("REFUSED", `outside the execution window — ${r.window.reason}`);
  deps.log(`   ✓ pre-flight clean, phase ARMED_FOR_RUN, window OK`);

  // ── stage narration switch (no restart) ─────────────────────────────
  steps.push("stage:DISABLE_ELEVEN=false(--skip-deploys)");
  await deps.setVars(SERVICE, { DISABLE_ELEVEN: "false" }, { skipDeploys: true });

  steps.push("verify-staged");
  const staged = await deps.readVars(SERVICE);
  if (staged.DISABLE_ELEVEN !== "false") return fail("REFUSED", "DISABLE_ELEVEN did not stage");
  if (staged.PIPELINE_MODE !== LOCK_VALUE) return fail("REFUSED", "staging unexpectedly removed the lock");
  if (staged.PILOT_ID !== PILOT_ID) return fail("REFUSED", "PILOT_ID drifted during staging");
  if (staged.TEST_STAGE !== "PRODUCTION") return fail("REFUSED", "TEST_STAGE drifted during staging");
  deps.log(`   ✓ staged DISABLE_ELEVEN=false with the lock still on`);

  steps.push("watermark");
  const watermark = deps.now();

  // ── IRREVERSIBLE from here ──────────────────────────────────────────
  let outcome: RunOutcome = "OBSERVATION_FAILED";
  let reason = "observation did not complete";
  let runId: string | null = null;

  try {
    steps.push("unlock:PIPELINE_MODE=production");
    deps.log(`   ▸ removing the auth_check lock — exactly one start follows`);
    await deps.setVars(SERVICE, { PIPELINE_MODE: UNLOCK_VALUE }, { skipDeploys: false });

    steps.push("observe");
    const observed = await observeSingleRun(deps, watermark);
    runId = observed.runId;
    outcome = observed.outcome;
    reason = observed.reason;
  } catch (err) {
    outcome = "OBSERVATION_FAILED";
    reason = `observation threw: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    // Best effort, always. A failure anywhere above must not leave production
    // unlocked, and a relock that did not take must not be quiet about it.
    steps.push("relock:PIPELINE_MODE=auth_check+DISABLE_ELEVEN=true");
    try {
      await deps.setVars(
        SERVICE,
        { PIPELINE_MODE: LOCK_VALUE, DISABLE_ELEVEN: "true" },
        { skipDeploys: false },
      );
      steps.push("verify-relock");
      const after = await deps.readVars(SERVICE);
      if (after.PIPELINE_MODE === LOCK_VALUE && after.DISABLE_ELEVEN === "true") {
        deps.log(`   ✓ relocked: PIPELINE_MODE=${LOCK_VALUE} DISABLE_ELEVEN=true`);
        // eslint-disable-next-line no-unsafe-finally
        return { outcome, reason, runId, relocked: true, relockError: null, steps };
      }
      const detail = `stored PIPELINE_MODE=${after.PIPELINE_MODE} DISABLE_ELEVEN=${after.DISABLE_ELEVEN}`;
      deps.log(`   ✗✗ RELOCK DID NOT TAKE — ${detail}`);
      // eslint-disable-next-line no-unsafe-finally
      return { outcome, reason, runId, relocked: false, relockError: detail, steps };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log(`   ✗✗ RELOCK FAILED — ${detail}. Run --relock immediately.`);
      // eslint-disable-next-line no-unsafe-finally
      return { outcome, reason, runId, relocked: false, relockError: detail, steps };
    }
  }
}

/**
 * Watch exactly the one run the unlock started, to a terminal state.
 *
 * Never triggers another start: it only reads. A run that never appears is an
 * observation failure, not an invitation to retry.
 */
async function observeSingleRun(
  deps: ControlDeps,
  watermark: Date,
): Promise<{ runId: string | null; outcome: RunOutcome; reason: string }> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const runs = await deps.runsSince(CHANNEL, watermark);
    const run = runs[runs.length - 1]; // oldest at/after the watermark = ours
    if (run && run.endTime) {
      return classifyRunOutcome(deps, run);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  return { runId: null, outcome: "OBSERVATION_FAILED", reason: "no terminal run observed within the poll budget" };
}

export async function classifyRunOutcome(
  deps: ControlDeps,
  run: RunRecord,
): Promise<{ runId: string; outcome: RunOutcome; reason: string }> {
  const unresolved = await deps.unresolvedIntentCount();
  if (unresolved > 0) {
    return { runId: run.id, outcome: "UPLOAD_AMBIGUOUS",
      reason: `${unresolved} unresolved upload intent(s) — reconcile before any retry` };
  }
  const reserved = await deps.totalReserved();
  if (reserved > 0) {
    return { runId: run.id, outcome: "FAILED_AFTER_RESERVATION",
      reason: `${reserved} chars still reserved — settle before any retry` };
  }
  if (run.status === "SUCCESS") {
    const pilot = await deps.readPilot(PILOT_ID);
    if (pilot && pilot.successCount > 0) {
      return { runId: run.id, outcome: "SUCCESS",
        reason: `pilot at ${pilot.successCount}/${pilot.maxSuccesses} — human review required before any further run` };
    }
    return { runId: run.id, outcome: "FAILED_BEFORE_SPEND",
      reason: "run reported SUCCESS but the pilot claimed no slot" };
  }
  // A non-success run with no reservation and no intent never bought anything.
  return { runId: run.id, outcome: "FAILED_BEFORE_SPEND",
    reason: `run terminal status ${run.status}; no reservation and no upload intent outstanding` };
}

// ── RELOCK ────────────────────────────────────────────────────────────────

export interface RelockResult {
  relocked: boolean;
  detail: string;
  activeRunsAtRequest: number;
}

/**
 * Move the service toward the safest state, independently of RUN.
 *
 * Sets the lock and re-disables narration in ONE invocation, so it costs one
 * restart rather than two. It never touches the pilot, the cap, Wet Circuit, or
 * any other variable.
 *
 * It does NOT promise to kill an already-running deployment: Railway restarts
 * the service, and a run mid-flight may continue until the container is
 * replaced. Any run active at the moment of request is reported for exactly
 * that reason.
 */
export async function doRelock(deps: ControlDeps): Promise<RelockResult> {
  const activeRunsAtRequest = await deps.activeRunCount();
  await deps.setVars(
    SERVICE,
    { PIPELINE_MODE: LOCK_VALUE, DISABLE_ELEVEN: "true" },
    { skipDeploys: false },
  );
  const after = await deps.readVars(SERVICE);
  const ok = after.PIPELINE_MODE === LOCK_VALUE && after.DISABLE_ELEVEN === "true";
  const detail = `stored PIPELINE_MODE=${after.PIPELINE_MODE} DISABLE_ELEVEN=${after.DISABLE_ELEVEN}`;
  deps.log(ok ? `   ✓ relocked — ${detail}` : `   ✗✗ RELOCK DID NOT TAKE — ${detail}`);
  if (activeRunsAtRequest > 0) {
    deps.log(`   ! ${activeRunsAtRequest} run(s) were active when relock was requested;` +
      ` a restart does not guarantee an in-flight run stops immediately`);
  }
  return { relocked: ok, detail, activeRunsAtRequest };
}

// ── ADVANCE CAP ───────────────────────────────────────────────────────────

export interface AdvanceResult { advanced: boolean; reason: string; from: number; to: number }

/**
 * Raise the durable cap by exactly one, after a human has reviewed the previous
 * private video. Only 1→2 and 2→3 are permitted, and only when the pilot's
 * durable record shows the previous success actually landed.
 *
 * Never starts a run: the next RUN still needs its own invocation and its own
 * M/W/F window.
 */
export async function doAdvanceCap(deps: ControlDeps, reviewed: boolean): Promise<AdvanceResult> {
  const none = (reason: string, from = 0, to = 0): AdvanceResult =>
    ({ advanced: false, reason, from, to });

  if (!reviewed) return none("--advance-cap requires --i-have-reviewed-the-previous-video");

  const state = await gatherState(deps);
  const p = state.pilot;
  if (!p) return none("pilot row missing");
  if (p.status !== "ACTIVE") return none(`pilot is ${p.status}; expected ACTIVE`);

  const from = p.maxSuccesses;
  const to = from + 1;
  if (!(from === 1 || from === 2)) {
    return none(
      from >= MAX_CAP
        ? `cap ${from} is the qualification target — complete the pilot instead of advancing`
        : `cap ${from} is not advanceable`,
      from, to);
  }
  if (p.successCount !== from) {
    return none(`successCount ${p.successCount} does not equal cap ${from} — the cap is not exhausted`, from, to);
  }
  if (p.successVideoIds.length !== p.successCount) {
    return none(
      `${p.successVideoIds.length} confirmed video(s) but ${p.successCount} claimed — reconcile first`, from, to);
  }

  // The previous success must actually exist, be uploaded, and still be
  // unscheduled. A cap advance is an assertion that a real video was reviewed.
  const lastId = p.successVideoIds[p.successVideoIds.length - 1]!;
  const video = await deps.videoById(lastId);
  if (!video) return none(`previous success ${lastId} has no Video row`, from, to);
  if (!video.youtubeId) return none(`previous success ${lastId} has no youtubeId`, from, to);
  if (video.status !== VideoStatus.UPLOADED) {
    return none(`previous success ${lastId} is ${video.status}, expected UPLOADED`, from, to);
  }
  if (video.scheduledAt) {
    return none(`previous success ${lastId} carries a publish time — refusing`, from, to);
  }

  if (state.unresolvedIntents > 0) return none("unresolved upload intent(s) — reconcile first", from, to);
  if (state.activeRuns > 0) return none("a pipeline run is active", from, to);
  if (state.vars.PIPELINE_MODE !== LOCK_VALUE) return none("service is not locked (auth_check)", from, to);
  if (state.vars.DISABLE_ELEVEN !== "true") return none("DISABLE_ELEVEN is not true", from, to);
  if (to > MAX_CAP) return none(`cap ${to} exceeds the maximum ${MAX_CAP}`, from, to);

  const rows = await deps.setMaxSuccesses(PILOT_ID, from, to);
  if (rows !== 1) return none(`cap update matched ${rows} rows, expected 1`, from, to);
  deps.log(`   ✓ cap ${from} → ${to}. One slot is available; RUN still needs its own window and invocation.`);
  return { advanced: true, reason: "advanced", from, to };
}

// ── Real dependency implementations ───────────────────────────────────────

async function railway(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("railway", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export function realDeps(): ControlDeps {
  const pilots = (prisma as never as { productionPilot: any }).productionPilot;
  return {
    async readVars(service) {
      const out = await railway(["variables", "--service", service, "--environment", ENVIRONMENT, "--kv"]);
      const kv: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return kv;
    },
    async setVars(service, kv, opts) {
      const pairs = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
      const args = ["variables", "set", ...pairs, "--service", service, "--environment", ENVIRONMENT];
      if (opts.skipDeploys) args.push("--skip-deploys");
      await railway(args);
    },
    readPilot: (pilotId) => pilots.findUnique({ where: { pilotId } }),
    async activatePilot(pilotId) {
      return prisma.$executeRawUnsafe(
        `UPDATE "production_pilot"
            SET "status"='ACTIVE', "activatedAt"=NOW(), "updatedAt"=NOW()
          WHERE "pilotId"=$1 AND "status"='PREPARED'
            AND "activatedAt" IS NULL AND "successCount"=0`,
        pilotId,
      );
    },
    async setMaxSuccesses(pilotId, from, to) {
      return prisma.$executeRawUnsafe(
        `UPDATE "production_pilot"
            SET "maxSuccesses"=$3, "updatedAt"=NOW()
          WHERE "pilotId"=$1 AND "status"='ACTIVE'
            AND "maxSuccesses"=$2 AND "successCount"=$2`,
        pilotId, from, to,
      );
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
    async runsSince(channel, since) {
      return prisma.pipelineRun.findMany({
        where: { channel, startTime: { gte: since } },
        orderBy: { startTime: "desc" },
        select: { id: true, channel: true, status: true, startTime: true, endTime: true },
      }) as unknown as Promise<RunRecord[]>;
    },
    videoById: (id) => prisma.video.findUnique({
      where: { id }, select: { id: true, youtubeId: true, status: true, scheduledAt: true },
    }) as never,
    now: () => new Date(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    log: (line) => console.log(line),
  };
}

// ── Entry point (only when run directly) ──────────────────────────────────

const ARM = process.argv.includes("--arm");
const RUN = process.argv.includes("--run");
const RELOCK = process.argv.includes("--relock");
const ADVANCE = process.argv.includes("--advance-cap");

export function selectedMode(argv: string[]): "ARM" | "RUN" | "RELOCK" | "ADVANCE_CAP" | "CHECK" | "AMBIGUOUS" {
  const picked = [
    argv.includes("--arm") && "ARM",
    argv.includes("--run") && "RUN",
    argv.includes("--relock") && "RELOCK",
    argv.includes("--advance-cap") && "ADVANCE_CAP",
  ].filter(Boolean) as string[];
  if (picked.length > 1) return "AMBIGUOUS";
  return (picked[0] as never) ?? "CHECK";
}

async function main(): Promise<void> {
  const mode = selectedMode(process.argv);
  const deps = realDeps();
  if (mode === "AMBIGUOUS") {
    console.error("✗ more than one mode flag given — refusing to guess");
    process.exitCode = 2;
    return;
  }
  if (mode === "CHECK") { await doCheck(deps); return; }
  if (mode === "ARM") {
    const r = await doArm(deps, process.argv.includes("--i-understand-this-activates-the-pilot"));
    if (!r.armed) { console.error(`✗ ARM refused: ${r.reason}`); process.exitCode = 1; }
    return;
  }
  if (mode === "RUN") {
    const r = await doRun(deps, process.argv.includes("--i-understand-this-spends-credits"));
    console.log(`\n  OUTCOME  : ${r.outcome}\n  reason   : ${r.reason}\n  run      : ${r.runId ?? "n/a"}`);
    console.log(`  relocked : ${r.relocked}${r.relockError ? ` (${r.relockError})` : ""}`);
    if (!r.relocked) { console.error("✗✗ SERVICE MAY STILL BE UNLOCKED — run --relock now."); process.exitCode = 1; }
    else if (r.outcome !== "SUCCESS") process.exitCode = 1;
    return;
  }
  if (mode === "RELOCK") {
    const r = await doRelock(deps);
    if (!r.relocked) process.exitCode = 1;
    return;
  }
  const r = await doAdvanceCap(deps, process.argv.includes("--i-have-reviewed-the-previous-video"));
  if (!r.advanced) { console.error(`✗ advance-cap refused: ${r.reason}`); process.exitCode = 1; }
}

// Importing this module (tests import the planners) must not run anything.
const isDirectRun =
  process.argv[1]?.endsWith("ai-doom-pilot-control.ts") ||
  process.argv[1]?.endsWith("ai-doom-pilot-control.js");

if (isDirectRun) {
  void ARM; void RUN; void RELOCK; void ADVANCE;
  main()
    .catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
