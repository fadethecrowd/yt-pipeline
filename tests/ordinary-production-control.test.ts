import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { zonedParts } from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import {
  SPECS, RUN_PLAN, CANONICAL_BRANCH, buildRunEnv, withEnv,
  evaluate, doCheck, doRun, doVerify, selectedMode, argValue,
} from "../scripts/ordinary-production-control";
import type { OrdinaryDeps, RunRecord, VideoRow } from "../scripts/ordinary-production-control";

/**
 * Guarded one-shot ordinary production.
 *
 * Neither channel has a recurring trigger, and with PIPELINE_MODE unlocked any
 * container start would make a video — there is no durable per-cycle
 * authorisation. So production is launched locally and Railway stays locked
 * forever. These tests pin the two properties that makes worth having: exactly
 * one pipeline invocation per authorisation, and not a single Railway mutation.
 */

const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");
const AI = SPECS["ai-doom-scroll"];
const WC = SPECS["wet-circuit"];
const TZ = "America/New_York";
const SAT = new Date("2026-08-08T16:00:00Z");

const completed = (spec = AI, over: Partial<PilotConfig> = {}): PilotConfig => ({
  id: "row", pilotId: spec.pilotId, channel: spec.key, channelId: "UC",
  status: "COMPLETED", maxSuccesses: spec.qualificationTarget,
  successCount: spec.qualificationTarget,
  successVideoIds: Array.from({ length: spec.qualificationTarget }, (_, i) => `v${i + 1}`),
  activatedAt: new Date("2026-08-03T21:00:00Z"), completedAt: new Date("2026-08-07T12:00:00Z"),
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20, timezone: TZ, ...over,
});

const GOOD_VARS: Record<string, Record<string, string>> = {
  "yt-pipeline": { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "true", PILOT_ID: "ai-doom-private-pilot-1" },
  "wc-pipeline": { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "true" },
  "monitor-ai-doom": { MONITOR_MODE: "health_only", MONITOR_AI_ENABLED: "false" },
  "monitor-wc": { MONITOR_MODE: "health_only", MONITOR_AI_ENABLED: "false" },
};

interface FakeOpts {
  pilot?: PilotConfig | null;
  vars?: Record<string, Record<string, string>>;
  source?: { branch: string | null; commit: string | null };
  healthy?: boolean;
  reserved?: number;
  limits?: { key: string; limit: number }[];
  active?: number;
  unresolved?: number;
  occupied?: Date[];
  runs?: RunRecord[];
  rows?: VideoRow[];
  invokeThrows?: boolean;
  onInvoke?: () => void;
}
interface Fake { deps: OrdinaryDeps; invoked: ChannelSeen[]; envSeen: (string | undefined)[] }
type ChannelSeen = string;

function makeFake(spec = AI, o: FakeOpts = {}): Fake {
  const invoked: ChannelSeen[] = [];
  const envSeen: (string | undefined)[] = [];
  const state = { unresolved: o.unresolved ?? 0, reserved: o.reserved ?? 0 };
  const deps: OrdinaryDeps = {
    async readPilot() { return o.pilot === undefined ? completed(spec) : o.pilot; },
    async readVars(svc) { return (o.vars ?? GOOD_VARS)[svc] ?? {}; },
    async deployedSource() {
      return o.source ?? { branch: "main", commit: "73ca139f34cd2ac7" };
    },
    async monitorHealthy() { return o.healthy ?? true; },
    async totalReserved() { return state.reserved; },
    async controlledLimits() { return o.limits ?? [{ key: "c/PRODUCTION", limit: 0 }]; },
    async activeRunCount() { return o.active ?? 0; },
    async unresolvedIntentCount() { return state.unresolved; },
    async futureScheduled() { return o.occupied ?? []; },
    async runsSince() { return o.runs ?? []; },
    async rowsSince() { return o.rows ?? []; },
    async rowById(_m, id) { return (o.rows ?? []).find((r) => r.id === id) ?? null; },
    async invokePipeline(ch) {
      invoked.push(ch);
      envSeen.push(process.env.PILOT_ID);
      o.onInvoke?.();
      if (o.invokeThrows) throw new Error("pipeline exploded");
    },
    now: () => SAT,
    log: () => {},
  };
  // Let a test flip state mid-run.
  (deps as unknown as { _state: typeof state })._state = state;
  return { deps, invoked, envSeen };
}

const run = (id: string, status: string): RunRecord => ({
  id, channel: "c", status, startTime: SAT, endTime: new Date(SAT.getTime() + 6e5),
});
const row = (over: Partial<VideoRow> = {}): VideoRow => ({
  id: "vid-new", youtubeId: "yt-new", status: "UPLOADED",
  scheduledAt: new Date("2026-08-10T19:00:00.000Z"), createdAt: SAT, ...over,
});

// ── 1-6. Invocation topology ─────────────────────────────────────────────

describe("1-6. direct invocation topology", () => {
  test("1/2. the control calls the channel pipeline once per RUN", async () => {
    for (const spec of [AI, WC]) {
      const f = makeFake(spec, { runs: [run("r", "SUCCESS")], rows: [row()] });
      const r = await doRun(f.deps, spec, true);
      assert.equal(r.invocations, 1);
      assert.equal(f.invoked.length, 1);
      assert.equal(f.invoked[0], spec.key);
    }
  });

  test("3/4. the pipeline's own resume path returns before discovery", () => {
    // The one-candidate guarantee lives in runPipeline, not in a wrapper loop.
    for (const p of ["src/pipeline.ts", "packages/wc-pipeline/src/pipeline.ts"]) {
      const src = readFileSync(p, "utf8");
      const resume = src.slice(src.indexOf("if (stuckVideo) {"));
      const end = resume.slice(0, resume.indexOf("\n    }\n"));
      assert.match(end, /return;/, `${p} resume block must return`);
    }
  });

  test("only one video row is ever created per invocation", () => {
    for (const [p, model] of [["src/pipeline.ts", "video"],
                              ["packages/wc-pipeline/src/pipeline.ts", "wcVideo"]] as const) {
      const body = readFileSync(p, "utf8");
      const fn = body.slice(body.indexOf("export async function runPipeline"));
      const creates = (fn.match(new RegExp(`prisma\\.${model}\\.create`, "g")) ?? []).length;
      assert.equal(creates, 1, `${p} must create exactly one ${model}`);
    }
  });

  test("the control adds no loop of its own", () => {
    const doRunBody = CTRL.slice(CTRL.indexOf("export async function doRun"), CTRL.indexOf("// ── VERIFY"));
    for (const t of ["for (", "while (", "retry", "again"]) {
      assert.ok(!doRunBody.includes(t), `RUN must not contain "${t}"`);
    }
  });

  test("5/6. RUN issues no Railway command at all", () => {
    const doRunBody = CTRL.slice(CTRL.indexOf("export async function doRun"), CTRL.indexOf("// ── VERIFY"));
    for (const t of ["railway", "variables set", "PIPELINE_MODE =", "redeploy", "restart"]) {
      assert.ok(!doRunBody.includes(t), `RUN must not reference ${t}`);
    }
  });

  test("the plan is fixed and ordered", () => {
    assert.deepEqual([...RUN_PLAN],
      ["preflight", "watermark", "invoke-once", "identify-run", "identify-video", "classify"]);
  });
});

// ── 7-19. CHECK ──────────────────────────────────────────────────────────

describe("7-19. CHECK gating", () => {
  test("7/8. a PREPARED or ACTIVE pilot is NOT_GRADUATED", async () => {
    for (const status of ["PREPARED", "ACTIVE"] as const) {
      const f = makeFake(AI, { pilot: completed(AI, { status, completedAt: null }) });
      assert.equal((await evaluate(f.deps, AI)).phase, "NOT_GRADUATED");
    }
  });

  test("a COMPLETED pilot with the wrong count is NOT_GRADUATED", async () => {
    const f = makeFake(AI, { pilot: completed(AI, { successCount: 2, successVideoIds: ["a", "b"] }) });
    assert.equal((await evaluate(f.deps, AI)).phase, "NOT_GRADUATED");
  });

  test("9/10. a properly completed pilot reaches READY_FOR_ONE_SHOT", async () => {
    for (const spec of [AI, WC]) {
      const f = makeFake(spec);
      const r = await evaluate(f.deps, spec);
      assert.equal(r.phase, "READY_FOR_ONE_SHOT", `${spec.key}: ${JSON.stringify(r.checks.filter(c => !c.ok))}`);
      assert.equal(r.ready, true);
    }
  });

  test("11. an unresolved intent refuses", async () => {
    assert.equal((await evaluate(makeFake(AI, { unresolved: 1 }).deps, AI)).phase,
      "RECONCILIATION_REQUIRED");
  });

  test("12. an active run refuses", async () => {
    assert.equal((await evaluate(makeFake(AI, { active: 1 }).deps, AI)).phase, "RUN_IN_PROGRESS");
  });

  test("13/14. a reservation or open budget refuses", async () => {
    assert.equal((await evaluate(makeFake(AI, { reserved: 500 }).deps, AI)).phase, "BUDGET_NOT_CLEAN");
    assert.equal((await evaluate(makeFake(AI,
      { limits: [{ key: "c/PRODUCTION", limit: 4000 }] }).deps, AI)).phase, "BUDGET_NOT_CLEAN");
  });

  test("15. a service not locked at auth_check refuses", async () => {
    const vars = { ...GOOD_VARS, "yt-pipeline": { PIPELINE_MODE: "production", DISABLE_ELEVEN: "true" } };
    assert.equal((await evaluate(makeFake(AI, { vars }).deps, AI)).phase, "SERVICE_UNLOCKED");
  });

  test("Railway DISABLE_ELEVEN must stay true while idle", async () => {
    const vars = { ...GOOD_VARS, "yt-pipeline": { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "false" } };
    assert.equal((await evaluate(makeFake(AI, { vars }).deps, AI)).phase, "SERVICE_UNLOCKED");
  });

  test("16/17. a monitor not health_only, or unhealthy, refuses", async () => {
    const vars = { ...GOOD_VARS, "monitor-ai-doom": { MONITOR_MODE: "active", MONITOR_AI_ENABLED: "false" } };
    assert.equal((await evaluate(makeFake(AI, { vars }).deps, AI)).phase, "MONITOR_UNHEALTHY");
    assert.equal((await evaluate(makeFake(AI, { healthy: false }).deps, AI)).phase, "MONITOR_UNHEALTHY");
  });

  test("18. a non-canonical deployed source refuses", async () => {
    for (const source of [
      { branch: null, commit: null },                       // CLI upload
      { branch: "some-feature", commit: "abc123" },          // wrong branch
      { branch: "main", commit: null },
    ]) {
      assert.equal((await evaluate(makeFake(AI, { source }).deps, AI)).phase, "SOURCE_MISMATCH");
    }
    assert.equal(CANONICAL_BRANCH, "main");
  });

  test("19. occupied slots move the target rather than duplicating", async () => {
    const mon = new Date("2026-08-10T19:00:00.000Z");
    const clean = await evaluate(makeFake(AI).deps, AI);
    assert.equal(clean.targetSlot?.toISOString(), "2026-08-10T19:00:00.000Z");
    const busy = await evaluate(makeFake(AI, { occupied: [mon] }).deps, AI);
    assert.equal(busy.targetSlot?.toISOString(), "2026-08-12T19:00:00.000Z");
    assert.equal(busy.phase, "READY_FOR_ONE_SHOT");
  });

  test("the target slot is Mon/Wed/Fri 15:00 ET and DST-correct", async () => {
    const r = await evaluate(makeFake(AI).deps, AI);
    const p = zonedParts(r.targetSlot!, TZ);
    assert.equal(p.hour, 15);
    assert.ok([1, 3, 5].includes(p.weekday));
  });

  test("CHECK mutates nothing and never invokes a pipeline", async () => {
    const f = makeFake(AI);
    await doCheck(f.deps, AI);
    assert.equal(f.invoked.length, 0);
  });
});

// ── 20-25. Local execution environment ───────────────────────────────────

describe("20-25. invocation environment", () => {
  test("20. PILOT_ID is absent in the run environment", () => {
    assert.equal(buildRunEnv(AI).PILOT_ID, undefined);
    assert.ok("PILOT_ID" in buildRunEnv(AI), "must be explicitly removed, not merely omitted");
  });

  test("23/24. TEST_STAGE=PRODUCTION and spend enabled, locally only", () => {
    const env = buildRunEnv(AI);
    assert.equal(env.TEST_STAGE, "PRODUCTION");
    assert.equal(env.DISABLE_ELEVEN, "false");
    assert.equal(env.DRY_RUN, "false");
  });

  test("the environment is scoped to the invocation and restored after", async () => {
    process.env.PILOT_ID = "ai-doom-private-pilot-1";
    process.env.DISABLE_ELEVEN = "true";
    let inside: (string | undefined)[] = [];
    await withEnv(buildRunEnv(AI), async () => {
      inside = [process.env.PILOT_ID, process.env.DISABLE_ELEVEN, process.env.TEST_STAGE];
    });
    assert.deepEqual(inside, [undefined, "false", "PRODUCTION"]);
    assert.equal(process.env.PILOT_ID, "ai-doom-private-pilot-1", "restored");
    assert.equal(process.env.DISABLE_ELEVEN, "true", "restored");
    delete process.env.PILOT_ID;
    delete process.env.DISABLE_ELEVEN;
  });

  test("the environment is restored even when the pipeline throws", async () => {
    process.env.PILOT_ID = "keep-me";
    await withEnv(buildRunEnv(AI), async () => { throw new Error("boom"); }).catch(() => {});
    assert.equal(process.env.PILOT_ID, "keep-me");
    delete process.env.PILOT_ID;
  });

  test("PILOT_ID really is unset at the moment the pipeline runs", async () => {
    process.env.PILOT_ID = "ai-doom-private-pilot-1";
    const f = makeFake(AI, { runs: [run("r", "SUCCESS")], rows: [row()] });
    await doRun(f.deps, AI, true);
    assert.deepEqual(f.envSeen, [undefined]);
    assert.equal(process.env.PILOT_ID, "ai-doom-private-pilot-1");
    delete process.env.PILOT_ID;
  });

  test("21/25. Railway variables are never written", () => {
    assert.ok(!CTRL.includes("variables set"));
    assert.ok(!CTRL.includes("--skip-deploys"));
    assert.ok(!CTRL.includes("redeploy"));
  });
});

// ── 26-43. RUN and failure semantics ─────────────────────────────────────

describe("26-43. RUN outcomes", () => {
  test("RUN without the acknowledgement does nothing", async () => {
    const f = makeFake(AI);
    const r = await doRun(f.deps, AI, false);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.invoked.length, 0);
  });

  test("RUN refuses whenever CHECK is not READY_FOR_ONE_SHOT", async () => {
    for (const o of [{ unresolved: 1 }, { active: 1 }, { reserved: 9 },
                     { pilot: completed(AI, { status: "ACTIVE" }) }, { healthy: false }]) {
      const f = makeFake(AI, o);
      const r = await doRun(f.deps, AI, true);
      assert.equal(r.outcome, "REFUSED");
      assert.equal(f.invoked.length, 0, "must not invoke on a failed pre-flight");
    }
  });

  test("26/35/36/37. success identifies the exact run and video", async () => {
    const f = makeFake(AI, { runs: [run("run-42", "SUCCESS")], rows: [row({ id: "vid-42" })] });
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "SUCCESS_SCHEDULED");
    assert.equal(r.runId, "run-42");
    assert.equal(r.videoId, "vid-42");
    assert.equal(r.youtubeId, "yt-new");
    assert.equal(r.scheduledAt?.toISOString(), "2026-08-10T19:00:00.000Z");
    assert.equal(r.invocations, 1);
  });

  test("32/33. the scheduled slot is a valid M/W/F 15:00 ET instant", async () => {
    const f = makeFake(AI, { runs: [run("r", "SUCCESS")], rows: [row()] });
    const r = await doRun(f.deps, AI, true);
    const p = zonedParts(r.scheduledAt!, TZ);
    assert.equal(p.hour, 15);
    assert.ok([1, 3, 5].includes(p.weekday));
  });

  test("38/40. an unresolved intent appearing during the run is ambiguous, never retried", async () => {
    const f = makeFake(AI, { runs: [run("r", "SUCCESS")], rows: [row()] });
    const st = (f.deps as unknown as { _state: { unresolved: number } })._state;
    const orig = f.deps.invokePipeline.bind(f.deps);
    f.deps.invokePipeline = async (c) => { await orig(c); st.unresolved = 1; };
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "UPLOAD_AMBIGUOUS");
    assert.match(r.reason, /reconcile before any future run/);
    assert.equal(r.invocations, 1);
  });

  test("42. a reservation left open is surfaced", async () => {
    const f = makeFake(AI, { runs: [run("r", "FAILED")], rows: [row({ status: "FAILED" })] });
    const st = (f.deps as unknown as { _state: { reserved: number } })._state;
    const orig = f.deps.invokePipeline.bind(f.deps);
    f.deps.invokePipeline = async (c) => { await orig(c); st.reserved = 4000; };
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "FAILED_AFTER_RESERVATION");
    assert.match(r.reason, /settle before any future run/);
  });

  test("39. a quality failure is classified and spends nothing", async () => {
    const f = makeFake(AI, {
      runs: [run("r", "FAILED")], rows: [row({ status: "QUALITY_FAILED", youtubeId: null, scheduledAt: null })],
    });
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "QUALITY_FAILED");
    assert.equal(r.youtubeId, null);
    assert.equal(r.scheduledAt, null);
  });

  test("41. a thrown pipeline never produces a second invocation", async () => {
    const f = makeFake(AI, { invokeThrows: true, runs: [run("r", "FAILED")], rows: [] });
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "FAILED_BEFORE_SPEND");
    assert.match(r.reason, /pipeline exploded/);
    assert.equal(r.invocations, 1);
    assert.equal(f.invoked.length, 1);
  });

  test("43. no run appearing at all is an observation failure", async () => {
    const f = makeFake(AI, { runs: [], rows: [] });
    const r = await doRun(f.deps, AI, true);
    assert.equal(r.outcome, "OBSERVATION_FAILED");
    assert.equal(r.invocations, 1);
  });

  test("a success without an upload is not reported as scheduled", async () => {
    const f = makeFake(AI, {
      runs: [run("r", "SUCCESS")], rows: [row({ youtubeId: null, scheduledAt: null })],
    });
    const r = await doRun(f.deps, AI, true);
    assert.notEqual(r.outcome, "SUCCESS_SCHEDULED");
  });
});

// ── VERIFY ───────────────────────────────────────────────────────────────

describe("VERIFY", () => {
  test("it needs an exact id and never guesses", async () => {
    assert.match(CTRL, /--video <row id> is required for VERIFY/);
    const f = makeFake(AI, { rows: [row({ id: "vid-9" })] });
    const r = await doVerify(f.deps, AI, "vid-9");
    assert.equal(r.found, true);
    assert.equal(r.consistent, true);
  });

  test("an incomplete row is reported inconsistent", async () => {
    const f = makeFake(AI, { rows: [row({ id: "v", youtubeId: null })] });
    assert.equal((await doVerify(f.deps, AI, "v")).consistent, false);
  });

  test("a missing row is reported, not invented", async () => {
    const f = makeFake(AI, { rows: [] });
    const r = await doVerify(f.deps, AI, "nope");
    assert.equal(r.found, false);
  });

  test("VERIFY invokes nothing", async () => {
    const f = makeFake(AI, { rows: [row()] });
    await doVerify(f.deps, AI, "vid-new");
    assert.equal(f.invoked.length, 0);
  });
});

// ── 44-48. Isolation ─────────────────────────────────────────────────────

describe("44-48. isolation", () => {
  test("44/45. each channel resolves only its own pipeline and model", async () => {
    const ai = makeFake(AI, { runs: [run("r", "SUCCESS")], rows: [row()] });
    await doRun(ai.deps, AI, true);
    assert.deepEqual(ai.invoked, ["ai-doom-scroll"]);
    const wc = makeFake(WC, { runs: [run("r", "SUCCESS")], rows: [row()] });
    await doRun(wc.deps, WC, true);
    assert.deepEqual(wc.invoked, ["wet-circuit"]);
    assert.equal(AI.model, "video");
    assert.equal(WC.model, "wcVideo");
  });

  test("WC can never enter the canary runner", () => {
    assert.ok(!CTRL.includes("runWcCanaryOnce"));
    assert.ok(!CTRL.includes("wc-canary-control"));
    // And the WC pipeline itself keeps them separate.
    const wcSrc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    const runFn = wcSrc.slice(wcSrc.indexOf("export async function runPipeline"),
      wcSrc.indexOf("export async function runWcCanaryOnce"));
    assert.ok(!runFn.includes("runWcCanaryOnce"));
  });

  test("46/47. no runtime imports it and it does nothing on import", () => {
    for (const f of ["src/index.ts", "src/pipeline.ts",
                     "packages/wc-pipeline/src/pipeline.ts", "packages/pipeline-core/src/index.ts",
                     "packages/monitor/src/index.ts"]) {
      assert.ok(!readFileSync(f, "utf8").includes("ordinary-production-control"), f);
    }
    assert.match(CTRL, /const isDirectRun =/);
    assert.match(CTRL, /if \(isDirectRun\) \{/);
  });

  test("48. the pipeline modules are imported lazily, so CHECK never loads them", () => {
    const staticImports = [...CTRL.matchAll(/^import .*?from "(.*?)";$/gm)].map((m) => m[1]);
    assert.ok(!staticImports.some((i) => i.includes("src/pipeline")), "no static pipeline import");
    assert.ok(!staticImports.some((i) => i.includes("wc-pipeline/src/pipeline")));
    assert.match(CTRL, /await import\("\.\.\/src\/pipeline"\)/);
  });

  test("mode and channel parsing never guess", () => {
    assert.equal(selectedMode(["n", "x"]), "CHECK");
    assert.equal(selectedMode(["n", "x", "--run"]), "RUN");
    assert.equal(selectedMode(["n", "x", "--run", "--verify"]), "AMBIGUOUS");
    assert.equal(argValue(["n", "x", "--channel", "wet-circuit"], "--channel"), "wet-circuit");
    assert.equal(argValue(["n", "x"], "--channel"), null);
  });

  test("the control never claims to be unattended", () => {
    assert.match(CTRL, /GUARDED MANUAL production/);
    assert.match(CTRL, /not unattended production/);
  });
});
