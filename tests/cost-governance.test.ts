import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveTotalTargetChars, DEFAULT_TOTAL_TARGET_CHARS, TOTAL_TARGET_CHARS,
} from "@yt-pipeline/pipeline-core";

/**
 * Cost governance.
 *
 * Narration is the only thing this system can spend real money on, so the
 * question is not "is there a limit" but "can the limit be removed by
 * accident". Every test below is a way that could happen.
 */

const BUDGET = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
const SCHED = readFileSync("packages/pipeline-core/src/lib/authorizationScheduler.ts", "utf8");
const TICK = readFileSync("packages/monitor/src/authorizationTick.ts", "utf8");
const HEALTH = readFileSync("packages/monitor/src/healthTick.ts", "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── The global ceiling cannot be removed by a bad env var ─────────────────

describe("global ceiling is fail-closed", () => {
  const quiet = (): void => {};

  test("unset falls back to the canonical ceiling", () => {
    assert.equal(resolveTotalTargetChars(undefined, quiet), DEFAULT_TOTAL_TARGET_CHARS);
    assert.equal(resolveTotalTargetChars("", quiet), DEFAULT_TOTAL_TARGET_CHARS);
    assert.equal(resolveTotalTargetChars("   ", quiet), DEFAULT_TOTAL_TARGET_CHARS);
  });

  test("a non-numeric value does NOT produce NaN", () => {
    // The original defect: Number("abc") is NaN, and `used + chars > NaN` is
    // false for every input, so the ceiling silently vanished.
    for (const bad of ["abc", "1,000", "12px", "true", "null", "NaN", "Infinity"]) {
      const v = resolveTotalTargetChars(bad, quiet);
      assert.ok(Number.isFinite(v), `${bad} produced a non-finite ceiling`);
      assert.equal(v, DEFAULT_TOTAL_TARGET_CHARS);
    }
  });

  test("a NaN ceiling would have disabled the guard entirely — proof", () => {
    const broken = Number("abc");
    assert.ok(!(500_000 + 100 > broken),
      "this is why NaN was dangerous: the comparison is false, so spend proceeds");
  });

  test("zero and negative values fall back rather than blocking or inverting", () => {
    for (const bad of ["0", "-1", "-297000"]) {
      assert.equal(resolveTotalTargetChars(bad, quiet), DEFAULT_TOTAL_TARGET_CHARS);
    }
  });

  test("a value above the canonical ceiling is clamped, not honoured", () => {
    assert.equal(resolveTotalTargetChars("999999999", quiet), DEFAULT_TOTAL_TARGET_CHARS);
    assert.equal(resolveTotalTargetChars("1e9", quiet), DEFAULT_TOTAL_TARGET_CHARS);
  });

  test("a smaller value IS honoured — tightening is always allowed", () => {
    assert.equal(resolveTotalTargetChars("50000", quiet), 50_000);
  });

  test("every fallback warns, so a misconfiguration is never silent", () => {
    for (const bad of ["abc", "-1", "999999999"]) {
      let warned = "";
      resolveTotalTargetChars(bad, (m) => { warned = m; });
      assert.ok(warned.length > 0, `${bad} fell back silently`);
    }
  });

  test("the resolved ceiling in this process is finite and positive", () => {
    assert.ok(Number.isFinite(TOTAL_TARGET_CHARS) && TOTAL_TARGET_CHARS > 0);
  });
});

// ── Concurrency and oversubscription ──────────────────────────────────────

describe("reservation cannot be oversubscribed", () => {
  test("the limit test lives INSIDE the conditional UPDATE, not before it", () => {
    const c = code(BUDGET);
    const fn = c.slice(c.indexOf("export async function reserveCredits"));
    assert.match(fn, /UPDATE credit_budget[\s\S]*?"chargedChars" \+ "reservedChars" \+ \$\{chars\} <= "limitChars"/,
      "a check outside the UPDATE would let two processes both pass it");
    assert.match(fn, /if \(updated === 0\)/, "a zero-row update must throw");
  });

  test("a disabled budget row cannot be reserved against", () => {
    const c = code(BUDGET);
    assert.match(c, /AND "enabled"\s+= TRUE/);
  });

  test("the global ceiling is checked across ALL channels and stages", () => {
    const c = code(BUDGET);
    const fn = c.slice(c.indexOf("export async function reserveCredits"));
    assert.match(fn, /aggregate\(\{[\s\S]*?_sum: \{ chargedChars: true, reservedChars: true \}/);
    assert.match(fn, /globalUsed \+ chars > TOTAL_TARGET_CHARS/);
  });

  test("in-flight reservations count toward the ceiling, not just charges", () => {
    const c = code(BUDGET);
    assert.match(c, /const globalUsed = \(all\._sum\.chargedChars \?\? 0\) \+ \(all\._sum\.reservedChars \?\? 0\)/);
  });
});

// ── Release semantics ─────────────────────────────────────────────────────

describe("reservations are released, and cannot go negative", () => {
  test("settle floors the reservation at zero", () => {
    assert.match(code(BUDGET), /GREATEST\(0, "reservedChars" - \$\{reserved\}\)/);
  });

  test("the budget window relocks in a finally, so a throw still relocks", () => {
    const c = code(BUDGET);
    const fn = c.slice(c.indexOf("export async function withBudgetWindow"));
    const tryAt = fn.indexOf("try {");
    const finallyAt = fn.indexOf("} finally {");
    assert.ok(tryAt >= 0 && finallyAt > tryAt);
    assert.match(fn.slice(finallyAt), /setBudgetLimit\(channel, stage, priorLimit\)/);
  });

  test("a hard-crash reservation leak is DETECTED even though it cannot be prevented", () => {
    // A SIGKILL between reserve and settle leaves reservedChars set: no
    // in-process finally can cover that. The control is detection plus an
    // operator procedure, and both must exist.
    const vh = readFileSync("packages/monitor/src/lib/videoHealth.ts", "utf8");
    assert.match(vh, /STALE_RESERVATION/);
    assert.match(vh, /BUDGET_OPEN_WHILE_IDLE/);
    const runbook = readFileSync("docs/YOUTUBE_PRODUCTION_OPERATIONS.md", "utf8");
    assert.match(runbook, /stuck reservation/i);
  });

  test("the ops status surfaces any non-zero reservation as an ALERT", () => {
    const ops = readFileSync("scripts/youtube-ops-status.ts", "utf8");
    assert.match(ops, /ALERT STALE_RESERVATION/);
  });
});

// ── Nothing but the pipeline can spend ────────────────────────────────────

describe("only the pipeline can spend", () => {
  const spendTokens = [
    "reserveCredits", "settleCredits", "withBudgetWindow", "setBudgetLimit",
    "synthesizeSegment", "elevenlabs", "ElevenLabs",
  ];

  for (const [name, src] of [
    ["the scheduler", SCHED],
    ["the monitor authorization tick", TICK],
    ["the monitor health tick", HEALTH],
  ] as const) {
    test(`${name} cannot spend`, () => {
      const c = code(src);
      for (const t of spendTokens) {
        assert.ok(!c.includes(t), `${name} references ${t}`);
      }
    });
  }

  test("auth_check exits before any stage, so it cannot spend", () => {
    for (const p of ["src/index.ts", "packages/wc-pipeline/src/index.ts"]) {
      const src = code(readFileSync(p, "utf8"));
      const modeAt = src.indexOf("auth_check");
      const runAt = src.search(/runPipeline\(/);
      assert.ok(modeAt >= 0, `${p} has no auth_check gate`);
      assert.ok(modeAt < runAt, `${p} reaches runPipeline before the auth_check gate`);
    }
  });

  test("read-only operator tooling cannot spend", () => {
    for (const p of ["scripts/youtube-ops-status.ts", "scripts/production-snapshot.ts",
                     "scripts/monday-preflight.ts"]) {
      const c = code(readFileSync(p, "utf8"));
      for (const t of ["reserveCredits", "setBudgetLimit", "withBudgetWindow", "synthesizeSegment"]) {
        assert.ok(!c.includes(t), `${p} references ${t}`);
      }
    }
  });
});

// ── Stage separation ──────────────────────────────────────────────────────

describe("stage budgets stay separated", () => {
  test("PRODUCTION defaults to a locked zero allocation", () => {
    assert.match(code(BUDGET), /PRODUCTION: 0,/);
  });

  test("budgets are keyed by (channel, testStage), so stages cannot borrow", () => {
    assert.match(code(BUDGET), /channel_testStage: \{ channel, testStage: stage \}/);
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /@@unique\(\[channel, testStage\]\)/);
  });
});
