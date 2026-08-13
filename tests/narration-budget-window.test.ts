import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  authorizeNarrationWindow, narrationCeilingChars, runtimeRange, charsForRuntime,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";

/**
 * Who may open a narration budget window, and for how much.
 *
 * The controlled production budget is 0 at rest and the pilot pre-flight
 * refuses to ARM unless it is. That is what makes "nothing buys narration by
 * accident" true. Wet Circuit has always had the other half — a window opened
 * to exactly one candidate's characters and closed in a `finally` — and AI
 * Doom did not, so its pilot could clear every gate and then die at
 * `reserveCredits` with "0 remaining".
 *
 * These tests are about the trust boundary, not the arithmetic. The decision
 * is pure, so every refusal below is checked without a database, a network or
 * a real pilot.
 */

const PILOT: PilotConfig = {
  id: "row-1", pilotId: "ai-doom-private-pilot-1",
  channel: "ai-doom-scroll", channelId: "UCSbJfiA1aobp6G_rgwbHPMw",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: new Date(), completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

const CEILING = narrationCeilingChars("ai-doom-scroll", "PRODUCTION" as never);

const ask = (over: Partial<Parameters<typeof authorizeNarrationWindow>[0]> = {}) =>
  authorizeNarrationWindow({
    channel: "ai-doom-scroll",
    stage: "PRODUCTION" as never,
    pilot: PILOT,
    submitChars: 5000,
    unattended: false,
    elevenDisabled: false,
    ...over,
  });

// ── The one way to succeed ────────────────────────────────────────────────

describe("an authorised AI Doom pilot candidate opens exactly its own window", () => {
  test("it opens, for exactly the characters it will submit", () => {
    const d = ask();
    assert.equal(d.open, true);
    if (!d.open) return;
    assert.equal(d.auth.submitChars, 5000, "the window is the submission, not the ceiling");
    assert.equal(d.auth.pilotId, "ai-doom-private-pilot-1");
    assert.equal(d.auth.channel, "ai-doom-scroll");
    assert.ok(d.auth.ceilingChars > 5000);
  });

  test("the ceiling comes from the durable runtime envelope, not the caller", () => {
    // A caller cannot widen its own allowance: the bound is the channel's
    // authorised maximum runtime expressed in characters.
    const expected = charsForRuntime(
      "ai-doom-scroll", runtimeRange("ai-doom-scroll", "LONGFORM", "PRODUCTION" as never).maxS);
    assert.equal(CEILING, expected);
  });
});

// ── Everything that must refuse ───────────────────────────────────────────

describe("the window refuses by default", () => {
  test("DISABLE_ELEVEN is checked first and blocks absolutely", () => {
    const d = ask({ elevenDisabled: true });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /DISABLE_ELEVEN/);
    // Even with everything else perfect, and even for a pilot that would
    // otherwise be allowed — the window must never be the thing that gets
    // narration past the hard disable.
    assert.equal(ask({ elevenDisabled: true, submitChars: 10 }).open, false);
  });

  test("ordinary production has no spend authority", () => {
    const d = ask({ pilot: null });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /ordinary production/);
  });

  test("unattended execution may not open a window even under an ACTIVE pilot", () => {
    const d = ask({ unattended: true });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /unattended/);
  });

  test("a pilot that is not ACTIVE is refused", () => {
    for (const status of ["PREPARED", "COMPLETED"]) {
      const d = ask({ pilot: { ...PILOT, status } as PilotConfig });
      assert.equal(d.open, false, status);
    }
  });

  test("a pilot with no slot left may not buy narration", () => {
    const d = ask({ pilot: { ...PILOT, successCount: 1, maxSuccesses: 1 } });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /no slots left/);
  });

  test("a pilot for another channel cannot draw on this one", () => {
    const d = ask({ pilot: { ...PILOT, channel: "wet-circuit" } });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /governs wet-circuit/);
  });

  test("a script beyond the durable ceiling fails closed before spend", () => {
    const d = ask({ submitChars: CEILING + 1 });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /exceeds the .* ceiling/);
    // And the boundary itself is allowed — the refusal is strictly above it.
    assert.equal(ask({ submitChars: CEILING }).open, true);
  });

  test("a nonsense character count is refused rather than opened", () => {
    for (const n of [0, -1, NaN, Infinity]) {
      assert.equal(ask({ submitChars: n }).open, false, String(n));
    }
  });
});

// ── The wiring, and what it must not disturb ──────────────────────────────

describe("the AI Doom voiceover stage is wired to the decision", () => {
  const SRC = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");

  test("it asks for authorisation before opening anything", () => {
    assert.match(SRC, /authorizeNarrationWindow\(/);
    assert.ok(SRC.indexOf("authorizeNarrationWindow(") < SRC.indexOf("withBudgetWindow("),
      "the decision must precede the window");
  });

  test("a refusal falls through to the unchanged path, budget still 0", () => {
    assert.match(SRC, /if \(!decision\.open\)/);
    assert.match(SRC, /return runVoiceover\(ctx, deps\);/);
  });

  test("the window is sized from the authorised submission", () => {
    assert.match(SRC, /withBudgetWindow\(channel, stage, auth\.submitChars,/);
  });

  test("supervision and the hard disable are read at the call site", () => {
    assert.match(SRC, /unattended: isUnattendedMode\(\)/);
    assert.match(SRC, /elevenDisabled: process\.env\.DISABLE_ELEVEN === "true"/);
  });

  test("no standing budget is ever set here", () => {
    assert.ok(!/setBudgetLimit/.test(SRC),
      "the stage must go through withBudgetWindow, never set a limit directly");
  });
});

describe("the surrounding controls are untouched", () => {
  test("withBudgetWindow still restores the prior limit in a finally", () => {
    const budget = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
    assert.match(budget, /finally \{\s*await setBudgetLimit\(channel, stage, priorLimit\)/);
    assert.match(budget, /PRODUCTION: 0/, "production stays locked at 0 by default");
  });

  test("reservation remains the atomic guard, and the window cannot exceed it", () => {
    const budget = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
    // The conditional UPDATE is what actually stops an over-spend; the window
    // only raises the ceiling it checks against.
    assert.match(budget, /AND "chargedChars" \+ "reservedChars" \+ \$\{chars\} <= "limitChars"/);
    assert.match(budget, /globalUsed \+ chars > TOTAL_TARGET_CHARS/,
      "the global ceiling still applies inside the window");
  });

  test("the AI Doom pilot pre-flight still demands zero at rest", () => {
    const ctl = readFileSync("scripts/ai-doom-pilot-control.ts", "utf8");
    assert.match(ctl, /controlled budgets locked at 0/);
    assert.match(ctl, /const nonZero = state\.limits\.filter\(\(l\) => l\.limit !== 0\)/);
  });

  test("Wet Circuit's own guarded voiceover is unchanged", () => {
    const wc = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
    assert.match(wc, /withBudgetWindow\("wet-circuit", testStage, submitChars,/);
    assert.ok(!/authorizeNarrationWindow/.test(wc),
      "WC keeps its existing authorisation; this change must not reach it");
  });

  test("the window neither clears nor masks a circuit breaker", () => {
    // Worth being exact about what exists. The breaker is a PRE-FLIGHT control
    // in this system, not an inline runtime gate: `assertCircuitClosed` is
    // exported but never called from a pipeline, and a tripped breaker is
    // caught by monday-preflight before a pilot is ever armed. That is
    // pre-existing and unchanged here — what these assertions defend is that
    // the new spend path cannot interfere with it.
    const win = readFileSync("packages/pipeline-core/src/lib/narrationWindow.ts", "utf8");
    const stage = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    for (const src of [win, stage]) {
      assert.ok(!/clearBreaker|tripBreaker/.test(src),
        "the narration window must never touch breaker state");
    }
    const preflight = readFileSync("scripts/monday-preflight.ts", "utf8");
    assert.match(preflight, /snap\.breakers\.filter\(\(b\) => b\.tripped\)/);
    assert.match(preflight, /"no circuit breaker tripped"/,
      "pre-flight must still refuse to arm while a breaker is tripped");
  });
});
