import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runWcCanaryOnce } from "../packages/wc-pipeline/src/pipeline";
import { WC_CANARY_AUTHORIZATIONS } from "../packages/wc-pipeline/src/canary/authorization";

/**
 * Execution topology for the private canary.
 *
 * The previous runbook said to start the canary with the ordinary root runner.
 * It could not work: the prepared candidate sits at VOICEOVER_PENDING, which
 * RESUME_FROM deliberately excludes, so runPipeline() does not select it. The
 * failure mode is not a refusal — it falls through to topicDiscovery and spends
 * the pilot's only slot on a different, brand-new video.
 *
 * These tests pin the shape of the fix: an explicit, id-addressed one-shot
 * runner that no container start can reach, and an ordinary runner that still
 * refuses to auto-resume anything that would re-spend.
 */

/** Repo-relative, matching the other suites: `npm test` runs from the root. */
const read = (p: string) => readFileSync(p, "utf8");

const PIPELINE = read("packages/wc-pipeline/src/pipeline.ts");
const INDEX = read("packages/wc-pipeline/src/index.ts");
const CONTROL = read("scripts/wc-canary-control.ts");
const RAILWAY_TOML = read("packages/wc-pipeline/railway.toml");

const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;

/** Body of RESUME_FROM, so assertions cannot match the surrounding prose. */
function resumeFromBody(): string {
  const start = PIPELINE.indexOf("const RESUME_FROM");
  assert.ok(start > 0, "RESUME_FROM declaration not found");
  const end = PIPELINE.indexOf("};", start);
  assert.ok(end > start, "RESUME_FROM body not terminated");
  return PIPELINE.slice(start, end);
}

/** Body of runWcCanaryOnce, likewise. */
function canaryBody(): string {
  const start = PIPELINE.indexOf("export async function runWcCanaryOnce");
  assert.ok(start > 0, "runWcCanaryOnce not found");
  const end = PIPELINE.indexOf("\n// ── Entry point", start);
  assert.ok(end > start, "runWcCanaryOnce body not terminated");
  return PIPELINE.slice(start, end);
}

describe("the ordinary runner still cannot start the canary", () => {
  test("VOICEOVER_PENDING is absent from RESUME_FROM", () => {
    // The whole reason the one-shot runner exists. If someone widens
    // RESUME_FROM to make the runbook work, every future crashed-mid-narration
    // row auto-resumes into paid ElevenLabs narration on the next container
    // boot. That is the regression this test exists to catch.
    assert.ok(
      !resumeFromBody().includes("VOICEOVER_PENDING"),
      "VOICEOVER_PENDING must NOT be resumable — it would auto-re-spend narration",
    );
  });

  test("SCRIPT_PENDING and SEO_PENDING are absent too", () => {
    const body = resumeFromBody();
    for (const status of ["SCRIPT_PENDING", "SEO_PENDING"]) {
      assert.ok(!body.includes(status), `${status} must NOT be resumable`);
    }
  });

  test("resumable statuses are exactly the five paid-work-complete states", () => {
    const body = resumeFromBody();
    const found = [...body.matchAll(/VideoStatus\.([A-Z_]+)\]/g)].map((m) => m[1]).sort();
    assert.deepEqual(found, [
      "ASSEMBLY_DONE", "ASSEMBLY_PENDING", "SEO_DONE", "UPLOAD_PENDING", "VOICEOVER_DONE",
    ]);
  });

  test("the resume query is driven by RESUME_FROM, not a separate literal list", () => {
    // Two lists would drift. The selector must derive from the same map the
    // resume-point lookup uses.
    assert.match(PIPELINE, /Object\.keys\(RESUME_FROM\) as VideoStatus\[\]/);
  });
});

describe("the one-shot runner is unreachable from process start", () => {
  test("index.ts never references runWcCanaryOnce", () => {
    // index.ts is what `startCommand` runs. If the canary were reachable from
    // there, a redeploy or an ON_FAILURE restart could start it with no human
    // in the loop.
    assert.ok(!INDEX.includes("runWcCanaryOnce"));
  });

  test("index.ts calls only runPipeline", () => {
    const calls = [...INDEX.matchAll(/\brun[A-Z]\w*\(/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(calls)], ["runPipeline("]);
  });

  test("the deployed start command runs index.js, not the control tool", () => {
    assert.match(RAILWAY_TOML, /startCommand = "node packages\/wc-pipeline\/dist\/index\.js"/);
    assert.ok(!RAILWAY_TOML.includes("wc-canary-control"));
  });

  test("pipeline.ts's own direct-run entry calls runPipeline, not the canary", () => {
    const start = PIPELINE.indexOf("if (isDirectRun)");
    assert.ok(start > 0);
    const tail = PIPELINE.slice(start);
    assert.ok(tail.includes("runPipeline()"));
    assert.ok(!tail.includes("runWcCanaryOnce("));
  });

  test("runWcCanaryOnce is exported for the control tool to call", () => {
    assert.equal(typeof runWcCanaryOnce, "function");
    // (videoId, summary?) — the id is required and positional, so it cannot be
    // defaulted to "whatever is lying around".
    assert.equal(runWcCanaryOnce.length, 2);
  });
});

describe("the one-shot runner has no discovery fallthrough", () => {
  test("it never calls topicDiscovery", () => {
    // This is the specific harm being prevented: the ordinary runner's
    // fallthrough creates a NEW video and burns the pilot's only slot.
    assert.ok(!canaryBody().includes("topicDiscovery"));
  });

  test("it selects the candidate by unique id, not by status scan", () => {
    const body = canaryBody();
    assert.match(body, /prisma\.wcVideo\.findUnique\(\{\s*where: \{ id: videoId \}/);
    assert.ok(!body.includes("findFirst"), "must not scan for a candidate");
    assert.ok(!body.includes("findMany"));
  });

  test("it starts at voiceover, so nothing before the paid work re-runs", () => {
    assert.match(PIPELINE, /const CANARY_START_STAGE = "voiceover"/);
    assert.match(canaryBody(), /stages\.findIndex\(\(s\) => s\.name === CANARY_START_STAGE\)/);
  });

  test("a drifted stage list fails closed rather than starting at index 0", () => {
    assert.match(canaryBody(), /if \(startIdx < 0\)[\s\S]{0,120}throw new Error/);
  });

  test("it filters skipDuringPilot, so Shorts cannot be produced", () => {
    assert.match(canaryBody(), /STAGES\.filter\(\(s\) => !s\.skipDuringPilot\)/);
  });
});

describe("the one-shot runner refuses anything but a clean armed candidate", () => {
  const body = canaryBody();

  test("it holds the same advisory lock as the ordinary runner", () => {
    // Otherwise a deployed run and a manual run could overlap.
    assert.match(body, /withAdvisoryLock\(prisma, WC_LOCK_ID/);
  });

  test("it runs the shared pilot gate rather than its own copy", () => {
    assert.match(body, /await pilotGate\(\)/);
    // One definition only — a second copy is a second place to miss a check.
    assert.equal((PIPELINE.match(/async function pilotGate\(/g) ?? []).length, 1);
  });

  test("it refuses to run without a pilot, so it is never uncapped", () => {
    assert.match(body, /CANARY_NO_PILOT/);
  });

  test("it requires a resolved canary authorisation, not just a window check", () => {
    assert.match(body, /resolveWcCanaryAuthorization\(\{/);
    assert.match(body, /CANARY_NOT_AUTHORIZED/);
  });

  test("authorisation is resolved against the candidate id it was asked to run", () => {
    assert.match(body, /candidateId: videoId/);
  });

  test("narration size comes from spoken units, not the raw script", () => {
    assert.match(body, /spokenCharacterCount\(buildSpokenUnits\(script\)\)/);
  });

  test("it requires exactly VOICEOVER_PENDING", () => {
    assert.match(body, /video\.status !== VideoStatus\.VOICEOVER_PENDING/);
    assert.match(body, /CANARY_WRONG_STATUS/);
  });

  test("it refuses a candidate that already produced paid artifacts", () => {
    // Re-entry guard: running from `voiceover` again would re-spend.
    for (const field of [
      "voiceoverPath", "voiceoverUrls", "videoPath", "youtubeId", "scheduledAt", "shortsUrl",
    ]) {
      assert.ok(body.includes(field), `re-entry guard must inspect ${field}`);
    }
    assert.match(body, /CANARY_ALREADY_STARTED/);
  });

  test("it honours quarantine explicitly", () => {
    assert.match(body, /quarantinedVideoIds\(\)/);
    assert.match(body, /CANARY_QUARANTINED/);
  });

  test("it refuses a candidate with no script", () => {
    assert.match(body, /CANARY_NO_SCRIPT/);
  });

  test("it refuses a candidate still tagged DRY_RUN", () => {
    // The candidate was prepared under DISABLE_ELEVEN=true, so its row says
    // DRY_RUN. The halt guard only blocks on FAILED + LIVE, so a DRY_RUN-tagged
    // canary that failed after real spend would halt nothing and the next run
    // would start a brand-new video.
    assert.match(body, /video\.runMode !== "LIVE"/);
    assert.match(body, /CANARY_RUNMODE_NOT_LIVE/);
  });

  test("every refusal is a throw, never a log-and-continue", () => {
    const codes = [
      "CANARY_NO_PILOT", "CANARY_QUARANTINED", "CANARY_CANDIDATE_MISSING",
      "CANARY_WRONG_STATUS", "CANARY_RUNMODE_NOT_LIVE", "CANARY_ALREADY_STARTED",
      "CANARY_NO_SCRIPT", "CANARY_NOT_AUTHORIZED",
    ];
    for (const code of codes) {
      const idx = body.indexOf(`"${code}"`);
      assert.ok(idx > 0, `${code} not found`);
      const before = body.slice(Math.max(0, idx - 200), idx);
      assert.ok(
        before.includes("throw new"),
        `${code} must be thrown, not logged`,
      );
    }
  });
});

describe("no path starts the canary twice", () => {
  const LOCK = read("packages/pipeline-core/src/lib/lock.ts");

  test("a second concurrent run cannot take the lock — it throws, not proceeds", () => {
    // Both the ordinary runner and the one-shot runner take WC_LOCK_ID, so a
    // deployed run and a manual run cannot overlap.
    assert.match(LOCK, /pg_try_advisory_lock/);
    assert.match(LOCK, /if \(!acquired\)[\s\S]{0,120}throw new Error/);
  });

  test("ARM cannot run twice — the second attempt matches zero rows", () => {
    // The WHERE pins QUALITY_FAILED, which the first ARM already left behind.
    const sql = CONTROL.slice(CONTROL.indexOf("export function armTransitionSql"));
    assert.match(sql, /AND "status" = 'QUALITY_FAILED'/);
    assert.match(CONTROL, /if \(moved !== 1\)/);
  });

  test("ARM flips runMode to LIVE so a failed canary arms the halt guard", () => {
    assert.match(CONTROL, /SET "status" = 'VOICEOVER_PENDING', "runMode" = 'LIVE'/);
  });

  test("the halt guard it arms blocks on LIVE failures", () => {
    const guard = PIPELINE.slice(PIPELINE.indexOf("const unackFailures"));
    assert.match(guard, /status: VideoStatus\.FAILED/);
    assert.match(guard, /runMode: "LIVE"/);
  });

  test("RUN cannot run twice — status has moved past VOICEOVER_PENDING", () => {
    assert.match(canaryBody(), /video\.status !== VideoStatus\.VOICEOVER_PENDING/);
  });

  test("a restart mid-narration cannot silently re-narrate", () => {
    // If narration wrote artifacts but the status never advanced, the re-entry
    // guard refuses rather than running `voiceover` again.
    assert.match(canaryBody(), /CANARY_ALREADY_STARTED/);
  });

  test("the pilot cap is enforced independently of the lock", () => {
    // A lock that is somehow not held must not become permission to exceed the
    // cap, so the gate re-reads the durable row every time.
    const gate = PIPELINE.slice(
      PIPELINE.indexOf("async function pilotGate("),
      PIPELINE.indexOf("// ── Orchestrator"),
    );
    assert.match(gate, /await remainingSlots\(pilot\.pilotId\)/);
    assert.match(gate, /PILOT_CAP_REACHED/);
    assert.match(gate, /assertRunnable\(pilot\)/);
  });
});

describe("the control tool is the only start path", () => {
  test("ARM and RUN both require the explicit confirm flag", () => {
    assert.match(CONTROL, /\(ARM \|\| RUN\) && !CONFIRMED/);
    assert.match(CONTROL, /--i-understand-this-spends-credits/);
  });

  test("CHECK remains the default phase", () => {
    assert.match(CONTROL, /const PHASE = RUN \? "RUN" : ARM \? "ARM" : "CHECK"/);
  });

  test("CHECK still mutates nothing", () => {
    const start = CONTROL.indexOf('if (PHASE === "CHECK")');
    const end = CONTROL.indexOf("if (ARM) {", start);
    assert.ok(start > 0 && end > start);
    const block = CONTROL.slice(start, end);
    assert.ok(!block.includes("$executeRaw"));
    assert.ok(!block.includes("withBudgetWindow"));
  });

  test("neither ARM nor RUN proceeds on a failed pre-flight", () => {
    const armIdx = CONTROL.indexOf("if (ARM) {");
    const guard = CONTROL.lastIndexOf("if (failed.length > 0)", armIdx);
    assert.ok(guard > 0 && guard < armIdx, "the clean-verdict guard must precede ARM");
  });

  test("ARM is a compare-and-set that must match exactly one row", () => {
    assert.match(CONTROL, /armTransitionSql\(\), AUTH\.candidateId/);
    assert.match(CONTROL, /if \(moved !== 1\)/);
  });

  test("pilot activation is also a compare-and-set on PREPARED", () => {
    assert.match(CONTROL, /'ACTIVE'[\s\S]{0,200}"status" = 'PREPARED' AND "activatedAt" IS NULL/);
    assert.match(CONTROL, /if \(activated !== 1\)/);
  });

  test("ARM opens no budget", () => {
    const start = CONTROL.indexOf("if (ARM) {");
    const end = CONTROL.indexOf("// ── RUN", start);
    assert.ok(start > 0 && end > start);
    assert.ok(!CONTROL.slice(start, end).includes("withBudgetWindow"));
  });

  test("RUN executes the one-shot runner, not the ordinary runner", () => {
    assert.match(CONTROL, /runWcCanaryOnce\(AUTH\.candidateId, summary\)/);
    // Scoped to the RUN block: the header docstring mentions runPipeline() when
    // explaining why the deployed service cannot reach the canary, and prose is
    // not a call site.
    const runBlock = CONTROL.slice(CONTROL.indexOf("// ── RUN"));
    assert.ok(!runBlock.includes("runPipeline("), "RUN must not invoke the ordinary runner");
    assert.ok(!CONTROL.includes("import { runPipeline"));
  });

  test("RUN's budget window is scoped to the measured narration size", () => {
    assert.match(
      CONTROL,
      /withBudgetWindow\(\s*\{ channel: "wet-circuit", testStage: "PRODUCTION", limit: submitCharsForBudget \}/,
    );
  });

  test("ARM and RUN are separate invocations", () => {
    // ARM must not fall through into RUN — arming is reviewable before spend.
    const armIdx = CONTROL.indexOf("if (ARM) {");
    const runIdx = CONTROL.indexOf("// ── RUN", armIdx);
    const armBlock = CONTROL.slice(armIdx, runIdx);
    assert.ok(armBlock.includes("return;"), "ARM must return before RUN");
    assert.ok(!armBlock.includes("runWcCanaryOnce"));
  });

  test("importing the control tool runs nothing", () => {
    assert.match(CONTROL, /const isDirectRun =/);
    assert.match(CONTROL, /if \(isDirectRun\) \{/);
  });

  test("the tool drives the candidate named in the durable authorisation", () => {
    assert.match(CONTROL, /const AUTH = WC_CANARY_AUTHORIZATIONS\[0\]!/);
    assert.equal(typeof AUTH.candidateId, "string");
    assert.ok(AUTH.candidateId.length > 0);
  });
});
