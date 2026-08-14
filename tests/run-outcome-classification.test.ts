import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyRunOutcome, PILOT_ID } from "../scripts/ai-doom-pilot-control";
import type { ControlDeps, RunRecord } from "../scripts/ai-doom-pilot-control";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";

/**
 * The controller must not tell an operator that nothing happened.
 *
 * On 2026-08-14 the one authorised attempt charged 5,263 characters, rendered,
 * and uploaded 3wAZeMbs3nc — and the controller reported FAILED_BEFORE_SPEND.
 *
 * The cause was an assumption written as a comment: "a non-success run with no
 * reservation and no intent never bought anything". WARNING is not a non-run.
 * `RunSummary.verifyOutputs` emits it when every stage COMPLETED but an
 * expected output is missing, and under a pilot two are missing by design —
 * `allowPublishAt: false` means no scheduledAt, `shortsEnabled: false` means
 * no Short. A textbook pilot success therefore lands on WARNING, and the
 * classifier read that as "stopped before spending".
 *
 * An operator reading FAILED_BEFORE_SPEND could reasonably have authorised
 * another attempt believing the first had done nothing. That is why this is a
 * safety-reporting defect and not a cosmetic one.
 */

const PILOT: PilotConfig = {
  id: "row-1", pilotId: PILOT_ID, channel: "ai-doom-scroll", channelId: "UC",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: new Date(), completedAt: null, privacyStatus: "private",
  allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

function deps(over: {
  pilot?: PilotConfig | null; reserved?: number; unresolved?: number;
} = {}): ControlDeps {
  return {
    readVars: async () => ({}),
    setVars: async () => {},
    readPilot: async () => (over.pilot === undefined ? PILOT : over.pilot),
    activatePilot: async () => 1,
    setMaxSuccesses: async () => 1,
    totalReserved: async () => over.reserved ?? 0,
    controlledLimits: async () => [],
    activeRunCount: async () => 0,
    unresolvedIntentCount: async () => over.unresolved ?? 0,
    runsSince: async () => [],
    videoById: async () => null,
    now: () => new Date(),
    sleep: async () => {},
    log: () => {},
  };
}

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1", channel: "ai-doom-scroll", status: "WARNING",
  startTime: new Date(), endTime: new Date(), ...over,
});

// ── The exact 2026-08-14 misreport ───────────────────────────────────────

describe("a completed run that produced a video is reported as SUCCESS", () => {
  test("WARNING plus a claimed pilot slot is a success, not a pre-spend failure", async () => {
    const r = await classifyRunOutcome(
      deps({ pilot: { ...PILOT, successCount: 1, successVideoIds: ["vid-A"] } }),
      run({
        status: "WARNING",
        youtubeId: "3wAZeMbs3nc",
        warnings: [
          "live: scheduledAt not set — long-form not scheduled",
          "live: shortsUrl not set — Short was not generated/uploaded",
        ],
      }),
    );
    assert.equal(r.outcome, "SUCCESS", "this is the bug: it reported FAILED_BEFORE_SPEND");
    assert.match(r.reason, /3wAZeMbs3nc/, "the operator must be told a video exists");
    assert.match(r.reason, /1\/1/);
    assert.match(r.reason, /human review required/);
  });

  test("the pilot-mandated warnings are surfaced, not hidden", async () => {
    const r = await classifyRunOutcome(
      deps({ pilot: { ...PILOT, successCount: 1 } }),
      run({ warnings: ["live: shortsUrl not set — Short was not generated/uploaded"] }),
    );
    assert.match(r.reason, /Short was not generated/);
  });

  test("plain SUCCESS still behaves exactly as before", async () => {
    const r = await classifyRunOutcome(
      deps({ pilot: { ...PILOT, successCount: 1 } }), run({ status: "SUCCESS" }));
    assert.equal(r.outcome, "SUCCESS");
  });

  test("a completed run whose pilot claimed nothing is still refused", async () => {
    const r = await classifyRunOutcome(deps(), run({ status: "WARNING" }));
    assert.equal(r.outcome, "FAILED_BEFORE_SPEND");
    assert.match(r.reason, /completed \(WARNING\) but the pilot claimed no slot/);
  });
});

// ── Genuinely stopped runs, now with a usable reason ─────────────────────

describe("a run that did not finish says why", () => {
  test("the failing stage and message reach the operator", async () => {
    const r = await classifyRunOutcome(deps(), run({
      status: "FAILED",
      failedStage: "visualFeasibilityGate",
      errorMessage: "visual feasibility FAILED — no narration purchased: usable-duration-margin",
    }));
    assert.equal(r.outcome, "FAILED_BEFORE_SPEND");
    assert.match(r.reason, /visualFeasibilityGate/);
    assert.match(r.reason, /usable-duration-margin/,
      "'terminal status FAILED' alone left an operator nothing to act on");
  });

  test("a missing failure detail degrades gracefully", async () => {
    const r = await classifyRunOutcome(deps(), run({ status: "FAILED" }));
    assert.equal(r.outcome, "FAILED_BEFORE_SPEND");
    assert.match(r.reason, /no failure detail recorded/);
  });

  test("IDLE and CRITICAL are still pre-spend outcomes", async () => {
    for (const status of ["IDLE", "CRITICAL"]) {
      const r = await classifyRunOutcome(deps(), run({ status }));
      assert.equal(r.outcome, "FAILED_BEFORE_SPEND", status);
    }
  });
});

// ── Never assert "no spend" from status alone ────────────────────────────

describe("a stopped run carrying a youtubeId is ambiguous, not clean", () => {
  test("it demands reconciliation instead of claiming nothing happened", async () => {
    const r = await classifyRunOutcome(deps(), run({
      status: "FAILED", youtubeId: "abc123", failedStage: "notify",
    }));
    assert.equal(r.outcome, "UPLOAD_AMBIGUOUS");
    assert.match(r.reason, /abc123/);
    assert.match(r.reason, /reconcile/);
  });
});

// ── The existing precedence must not have moved ──────────────────────────

describe("reservation and intent checks still outrank everything", () => {
  test("an unresolved intent is still reported first", async () => {
    const r = await classifyRunOutcome(
      deps({ unresolved: 1, pilot: { ...PILOT, successCount: 1 } }),
      run({ status: "WARNING", youtubeId: "x" }));
    assert.equal(r.outcome, "UPLOAD_AMBIGUOUS");
  });

  test("an open reservation is still reported before any outcome", async () => {
    const r = await classifyRunOutcome(
      deps({ reserved: 4000, pilot: { ...PILOT, successCount: 1 } }),
      run({ status: "WARNING" }));
    assert.equal(r.outcome, "FAILED_AFTER_RESERVATION");
  });
});
