import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyFailedRun, checkPipelineHealth } from "../packages/monitor/src/lib/videoHealth";
import type { RunView, RunSpendEvidence } from "../packages/monitor/src/lib/videoHealth";

/**
 * A candidate refused before spend is the safety system working.
 *
 * The monitor reported every terminal FAILED run as an ALERT for 24 hours, and
 * ordinary-production readiness refuses while an active finding exists. So one
 * script that came out too long — caught by a deliberate gate, costing nothing —
 * locked the channel out for a day. Twice in a row, on 2026-08-15 and again on
 * 2026-08-16.
 *
 * That is an operational cost with no safety benefit. What it protects against
 * is a failure that happened AFTER something irreversible: narration bought, a
 * reservation left open, a render made, an upload attempted, a video on the
 * channel. Those must still block, and still do.
 *
 * The distinction is drawn only from durable accounting — never from
 * `run.status`, never from the stage name, never from a run id. Missing
 * evidence blocks.
 */

const CLEAN: RunSpendEvidence = {
  narrationRows: 0,
  reservedChars: 0,
  candidateTerminal: true,
  hasRenderArtifact: false,
  uploadIntents: 0,
  youtubeId: null,
  scheduledAt: null,
};

const run = (evidence?: RunSpendEvidence, over: Partial<RunView> = {}): RunView => ({
  id: "run-1", status: "FAILED",
  startTime: new Date("2026-08-16T13:00:00Z"),
  endTime: new Date("2026-08-16T13:02:00Z"),
  evidence, ...over,
});

const NOW = new Date("2026-08-16T14:00:00Z");
const findings = (r: RunView) => checkPipelineHealth([r], NOW);
const active = (r: RunView) => findings(r).filter((f) => f.severity !== "OK");

// ── 1-3. Safe pre-spend rejections ───────────────────────────────────────

describe("1-3. gates that refused a candidate are not incidents", () => {
  test("1/2/3. quality, script length and feasibility rejections are non-blocking", () => {
    // The classification does not read the stage — the same clean evidence is
    // what makes all three safe, whichever gate did the refusing.
    const c = classifyFailedRun(run(CLEAN));
    assert.equal(c.blocking, false);
    assert.match(c.reason, /rejected before anything irreversible/);
  });

  test("11. it is recorded as a diagnostic, not an active finding", () => {
    const f = findings(run(CLEAN));
    assert.equal(f.length, 1, "the event must remain visible");
    assert.equal(f[0]!.code, "CANDIDATE_REJECTED_BEFORE_SPEND");
    assert.equal(f[0]!.severity, "OK");
    assert.equal(active(run(CLEAN)).length, 0, "and must not hold the channel unhealthy");
  });

  test("the diagnostic still names the run and says why", () => {
    const f = findings(run(CLEAN))[0]!;
    assert.equal(f.subject, "run-1");
    assert.match(f.detail, /terminal status FAILED/);
    assert.match(f.detail, /no narration/);
  });

  test("CRITICAL with clean evidence is treated the same way", () => {
    assert.equal(active(run(CLEAN, { status: "CRITICAL" })).length, 0);
  });
});

// ── 4-10. Everything else still blocks ───────────────────────────────────

describe("4-10. anything past the pre-spend boundary blocks", () => {
  const blocks = (patch: Partial<RunSpendEvidence>, expect: RegExp) => {
    const r = run({ ...CLEAN, ...patch });
    const c = classifyFailedRun(r);
    assert.equal(c.blocking, true, JSON.stringify(patch));
    assert.match(c.reason, expect);
    const f = active(r);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.code, "RUN_FAILED");
    assert.equal(f[0]!.severity, "ALERT");
  };

  test("4. any narration usage row blocks", () => blocks({ narrationRows: 1 }, /provider spend occurred/));
  test("5. an outstanding reservation blocks", () => blocks({ reservedChars: 400 }, /still reserved/));
  test("6. a render artifact blocks", () => blocks({ hasRenderArtifact: true }, /render artifact/));
  test("7. an upload intent blocks", () => blocks({ uploadIntents: 1 }, /upload intent/));
  test("8. a youtubeId blocks", () => blocks({ youtubeId: "abc123" }, /abc123/));
  test("a publish time blocks", () => blocks({ scheduledAt: NOW }, /publish time/));
  test("a non-terminal candidate blocks", () => blocks({ candidateTerminal: false }, /not in a terminal state/));

  test("9/10. missing evidence blocks — unknown is never safe", () => {
    const c = classifyFailedRun(run(undefined));
    assert.equal(c.blocking, true);
    assert.match(c.reason, /no spend evidence available/);
    assert.equal(active(run(undefined))[0]!.code, "RUN_FAILED");
  });

  test("the classification never looks at the stage or the run id", () => {
    const src = readFileSync("packages/monitor/src/lib/videoHealth.ts", "utf8");
    const fn = src.slice(src.indexOf("export function classifyFailedRun"),
      src.indexOf("/** D. Pipeline health. */"));
    for (const forbidden of ["failedStage", "visualFeasibility", "qualityGate", "00959a09", "ef5999ea"]) {
      assert.ok(!fn.includes(forbidden), `must not depend on ${forbidden}`);
    }
  });

  test("a still-running run is unaffected by any of this", () => {
    const stuck = run(undefined, { endTime: null, startTime: new Date("2026-08-16T10:00:00Z") });
    const f = active(stuck);
    assert.equal(f[0]!.code, "RUN_STUCK", "an in-flight run is judged on liveness, not spend");
  });

  test("a successful run produces no finding at all", () => {
    assert.equal(findings(run(undefined, { status: "SUCCESS" })).length, 0);
    assert.equal(findings(run(undefined, { status: "WARNING" })).length, 0);
  });
});

// ── 12-13. What readiness sees ───────────────────────────────────────────

describe("12-13. the tick verdict follows active findings only", () => {
  const TICK = readFileSync("packages/monitor/src/healthTick.ts", "utf8");

  test("12. an OK-severity diagnostic does not suppress the healthy verdict", () => {
    assert.match(TICK, /const active = report\.findings\.filter\(\(f\) => f\.severity !== "OK"\)/);
    assert.match(TICK, /if \(active\.length === 0\) \{/,
      "a tick with only diagnostics is a clean tick");
  });

  test("13. a real finding still makes the tick unclean", () => {
    // `active` is what gates the verdict, and an ALERT is active by definition.
    assert.ok(TICK.indexOf("const active") < TICK.indexOf("if (active.length === 0)"));
  });

  test("diagnostics are logged but never paged to a human", () => {
    assert.match(TICK, /dedupeAlerts\(\{ findings: active/,
      "only active findings may notify");
    assert.match(TICK, /for \(const f of report\.findings\)/,
      "but every finding is still written to the audit trail");
  });

  test("the healthy line notes that diagnostics were recorded", () => {
    assert.match(TICK, /diagnostic note\(s\)/);
  });

  test("channel health already ignored OK severity", () => {
    const src = readFileSync("packages/monitor/src/lib/videoHealth.ts", "utf8");
    assert.match(src, /healthy: findings\.every\(\(f\) => f\.severity === "OK"\)/);
  });
});

// ── The two real runs, as generic evidence ───────────────────────────────

describe("both real rejections classify safely on their durable facts", () => {
  /**
   * Verified against the database before this was written: for both
   * ef5999ea-… and 00959a09-…, elevenlabs_usage is 0 by run AND by candidate,
   * upload intents 0, qa records 0, videoPath null, youtubeId null,
   * scheduledAt null, candidate FAILED, reserved 0, and AI Doom PRODUCTION
   * charged unchanged at 21,491.
   */
  test("their evidence shape is non-blocking", () => {
    for (const id of ["ef5999ea-5390-4271-9a5e-fd87d8e48dfa",
                      "00959a09-be74-4ca5-abc5-3b54293ed692"]) {
      const c = classifyFailedRun(run(CLEAN, { id }));
      assert.equal(c.blocking, false, id);
    }
  });

  test("one dirty field would have flipped either of them", () => {
    const c = classifyFailedRun(run({ ...CLEAN, narrationRows: 1 },
      { id: "ef5999ea-5390-4271-9a5e-fd87d8e48dfa" }));
    assert.equal(c.blocking, true, "the id grants nothing — the evidence decides");
  });
});
