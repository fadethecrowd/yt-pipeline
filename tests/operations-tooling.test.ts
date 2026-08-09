import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/**
 * The runbook and the read-only tooling.
 *
 * A runbook rots silently: a flag gets renamed, an acknowledgement phrase
 * changes, and the document keeps saying the old thing until someone follows it
 * during an incident. So every command the runbook tells a human to type is
 * checked here against the script that would have to accept it.
 */

const RUNBOOK = readFileSync("docs/YOUTUBE_PRODUCTION_OPERATIONS.md", "utf8");
const PREFLIGHT = readFileSync("scripts/monday-preflight.ts", "utf8");
const SNAPSHOT = readFileSync("scripts/production-snapshot.ts", "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `npx tsx scripts/...` invocation the runbook contains. */
function runbookScripts(): string[] {
  return [...RUNBOOK.matchAll(/npx tsx (scripts\/[\w-]+\.ts)/g)].map((m) => m[1]);
}

describe("runbook commands are real", () => {
  test("every script the runbook invokes exists", () => {
    const missing = [...new Set(runbookScripts())].filter((p) => !existsSync(p));
    assert.deepEqual(missing, [], `runbook references missing scripts: ${missing.join(", ")}`);
  });

  test("every acknowledgement phrase the runbook quotes is accepted by its script", () => {
    const pairs: [string, string][] = [
      ["scripts/production-cycle-control.ts", "--i-understand-this-authorizes-one-unattended-video"],
      ["scripts/production-cycle-control.ts", "--i-understand-this-terminates-an-abandoned-cycle"],
      ["scripts/ordinary-production-control.ts", "--i-understand-this-creates-and-schedules-a-production-video"],
      ["scripts/video-publication-control.ts", "--i-have-reviewed-and-approved-this-video"],
      ["scripts/ai-doom-pilot-control.ts", "--i-understand-this-activates-the-pilot"],
      ["scripts/ai-doom-pilot-control.ts", "--i-understand-this-spends-credits"],
      ["scripts/ai-doom-pilot-control.ts", "--i-have-reviewed-the-previous-video"],
      ["scripts/wc-canary-control.ts", "--i-understand-this-spends-credits"],
    ];
    for (const [script, phrase] of pairs) {
      assert.ok(RUNBOOK.includes(phrase), `runbook is missing ${phrase}`);
      assert.ok(readFileSync(script, "utf8").includes(phrase),
        `${script} does not accept ${phrase}`);
    }
  });

  test("every mode flag the runbook uses is parsed by its script", () => {
    const pairs: [string, string[]][] = [
      ["scripts/production-cycle-control.ts", ["--check", "--authorize", "--verify", "--inspect-stale", "--reap", "--channel", "--cycle"]],
      ["scripts/authorization-scheduler-control.ts", ["--check", "--dry-run", "--run"]],
      ["scripts/ordinary-production-control.ts", ["--channel", "--run", "--verify"]],
      ["scripts/video-publication-control.ts", ["--channel", "--video", "--schedule", "--verify"]],
      ["scripts/ai-doom-pilot-control.ts", ["--arm", "--run", "--relock", "--advance-cap"]],
      ["scripts/wc-canary-control.ts", ["--arm", "--run"]],
    ];
    for (const [script, flags] of pairs) {
      const src = readFileSync(script, "utf8");
      for (const f of flags) {
        assert.ok(src.includes(`"${f}"`), `${script} does not handle ${f}`);
      }
    }
  });

  test("the runbook's env var names match the code that reads them", () => {
    const core = readFileSync("packages/pipeline-core/src/lib/authorizationScheduler.ts", "utf8");
    const gate = readFileSync("packages/pipeline-core/src/lib/unattendedGate.ts", "utf8");
    const monitor = readFileSync("packages/monitor/src/index.ts", "utf8");
    assert.match(core, /env\.SCHEDULER_ENABLED/);
    assert.match(gate, /env\.PRODUCTION_MODE/);
    assert.match(monitor, /process\.env\.MONITOR_MODE/);
    for (const v of ["SCHEDULER_ENABLED", "PRODUCTION_MODE", "MONITOR_MODE",
                     "PIPELINE_MODE", "DISABLE_ELEVEN", "MONITOR_AI_ENABLED"]) {
      assert.ok(RUNBOOK.includes(v), `runbook never mentions ${v}`);
    }
  });

  test("the runbook keeps the --skip-deploys warning on every variables set", () => {
    const sets = [...RUNBOOK.matchAll(/railway variables set [^\n]*/g)].map((m) => m[0]);
    assert.ok(sets.length > 0);
    for (const s of sets) {
      assert.ok(s.includes("--skip-deploys"),
        `"${s}" omits --skip-deploys, which triggers a git redeploy from main`);
    }
  });

  test("the runbook's channel/lock table matches the code", () => {
    assert.match(RUNBOOK, /ai-doom-scroll.*123456/);
    assert.match(RUNBOOK, /wet-circuit.*789012/);
    const wc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.match(wc, /WC_LOCK_ID = 789012/);
  });

  test("the runbook documents every cycle status the code can produce", () => {
    const cycle = readFileSync("packages/pipeline-core/src/lib/productionCycle.ts", "utf8");
    const statuses = [...cycle.matchAll(/^\s*\| "(\w+)"$/gm)].map((m) => m[1]);
    assert.ok(statuses.length >= 4);
    for (const s of ["AUTHORIZED", "CLAIMED", "COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"]) {
      assert.ok(RUNBOOK.includes(s), `runbook omits status ${s}`);
    }
  });

  test("the runbook documents every upload-intent state", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const block = schema.slice(schema.indexOf("enum UploadIntentState"));
    const states = [...block.slice(0, block.indexOf("}")).matchAll(/^\s{2}([A-Z_]+)$/gm)]
      .map((m) => m[1]);
    assert.ok(states.length >= 6, `found ${states.length} states`);
    for (const s of states) {
      assert.ok(RUNBOOK.includes(s), `runbook omits intent state ${s}`);
    }
  });

  test("the runbook states the frozen-migration hazard", () => {
    assert.match(RUNBOOK, /_prisma_migrations.*frozen at 0011/s);
    assert.match(RUNBOOK, /never run `prisma migrate deploy`/i);
  });
});

describe("read-only tooling stays read-only", () => {
  for (const [name, src] of [["preflight", PREFLIGHT], ["snapshot", SNAPSHOT]] as const) {
    test(`${name} issues no writes`, () => {
      const c = code(src);
      for (const w of ["$executeRaw", "INSERT ", "UPDATE ", "DELETE ", ".update(", ".create(", ".delete("]) {
        assert.ok(!c.includes(w), `${name} must not contain ${w}`);
      }
    });
    test(`${name} is local-only`, () => {
      assert.match(src, /const isDirectRun =/);
    });
  }

  test("preflight cannot mutate its way to PASS", () => {
    const c = code(PREFLIGHT);
    // Remedy STRINGS naming `railway variables set` are the point of the tool.
    // What must not exist is an invocation of one. Every shell-out goes through
    // sh(), so check its call sites rather than the file's prose.
    const calls = [...c.matchAll(/sh\("(\w+)", \[([^\]]*)\]/g)]
      .map((m) => `${m[1]} ${m[2].replace(/["'\s]/g, "")}`);
    assert.ok(calls.length > 0, "expected some shell-outs to check");
    for (const call of calls) {
      assert.ok(!/variables.*set|redeploy|up\b|deploy\b/.test(call),
        `preflight invokes a mutating command: ${call}`);
      assert.ok(/^(git|railway)/.test(call), `unexpected shell-out: ${call}`);
    }
    assert.match(c, /MONDAY_PREFLIGHT = \$\{failed\.length === 0 \? "PASS" : "FAIL"\}/);
  });

  test("preflight treats a SKIPPED deployment as up to date, not stale", () => {
    // Watch Paths legitimately skip all four services when a release touches
    // only scripts/, docs/ or tests/. Requiring SUCCESS would make the safest
    // possible release look like a deployment failure every time.
    const c = code(PREFLIGHT);
    assert.match(c, /status === "SUCCESS" \|\| status === "SKIPPED"/);
    assert.match(c, /const newest = rows\[0\]/);
  });

  test("preflight still rejects a failed or unsettled deployment", () => {
    const c = code(PREFLIGHT);
    assert.match(c, /settled && onMain && branch === "main"/);
  });

  test("preflight fails closed when a check cannot be evaluated", () => {
    const c = code(PREFLIGHT);
    // An unreadable Railway CLI must record a FAILING check, not skip silently.
    assert.match(c, /ck\(false, `\$\{svc\} deployment readable`/);
  });

  test("preflight's feasibility path matches the canary control's", () => {
    const canary = readFileSync("scripts/wc-canary-control.ts", "utf8");
    const path = canary.match(/VERIFICATION_PATH = "([^"]+)"/)?.[1];
    assert.ok(path, "canary control has no VERIFICATION_PATH");
    assert.ok(PREFLIGHT.includes(`"${path}"`),
      `preflight reads a different path than ${path}`);
  });

  test("preflight's feasibility max age matches the canary control's", () => {
    const canary = readFileSync("scripts/wc-canary-control.ts", "utf8");
    const age = canary.match(/FEASIBILITY_MAX_AGE_H = (\d+)/)?.[1];
    assert.ok(age);
    assert.match(PREFLIGHT, new RegExp(`FEASIBILITY_MAX_AGE_H = ${age}`));
  });

  test("preflight pins the WC candidate the authorization pins", () => {
    const auth = readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8");
    const id = auth.match(/candidateId: "([^"]+)"/)?.[1];
    assert.ok(id);
    assert.ok(PREFLIGHT.includes(id), `preflight does not pin candidate ${id}`);
  });
});
