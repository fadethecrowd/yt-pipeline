import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyMonitorHealth } from "../scripts/ordinary-production-control";

/**
 * Why a healthy monitor blocked production on 2026-08-15.
 *
 * The human authorized an N=1 tranche and launched the controller. It refused
 * before invoking anything:
 *
 *   OUTCOME : REFUSED
 *   reason  : phase is MONITOR_UNHEALTHY, expected READY_FOR_ONE_SHOT
 *
 * The monitor was fine. It had been ticking hourly all day and its most recent
 * tick said `ai-doom-scroll: healthy — 0 scheduled video(s) checked`.
 *
 * The predicate was `railway logs | filter "[monitor:health]" | last |
 * includes("healthy —")`, and it was wrong three separate ways:
 *
 *   1. The tick BANNER and the healthy VERDICT both carry `[monitor:health]`,
 *      and Railway does not guarantee ordering within a batch. The live logs
 *      printed the 00:18 verdict BEFORE its own banner, so "the last matching
 *      line" was the banner — which does not contain "healthy —".
 *   2. It was not channel-scoped.
 *   3. It had no freshness check whatsoever, so it would equally have passed on
 *      a "healthy —" line from three days before. It could fail while healthy
 *      and pass while dead.
 *
 * The fixture below is the real interleaving, copied from the live logs.
 */

const CH = "ai-doom-scroll";
const NOW = new Date("2026-08-15T00:26:30.000Z");
const HOUR = 3_600_000;

const tick = (iso: string, channel = CH) =>
  `[monitor:health] ═══ Health tick (${channel}) at ${iso} ═══`;
const healthy = (channel = CH) =>
  `[monitor:health] ${channel}: healthy — 0 scheduled video(s) checked`;
const sched = "[scheduler:ai-doom-scroll] SKIPPED_DISABLED: SCHEDULER_ENABLED is not \"true\"";

/** Exactly what `railway logs` returned during the incident. */
const INCIDENT_LOGS = [
  tick("2026-08-14T22:18:39.899Z"), sched, healthy(), sched, sched, sched,
  tick("2026-08-14T23:18:39.998Z"), sched, healthy(), sched, sched, sched,
  // The out-of-order pair that broke it: verdict, THEN its own banner.
  healthy(),
  tick("2026-08-15T00:18:40.096Z"),
  sched,
].join("\n");

const ask = (o: Partial<{ logs: string; channel: string; intervalMs: number | null; now: Date }> = {}) =>
  classifyMonitorHealth({
    logs: INCIDENT_LOGS, channel: CH, intervalMs: HOUR, now: NOW, ...o,
  });

// ── The incident ─────────────────────────────────────────────────────────

describe("the 2026-08-15 refusal against a healthy monitor", () => {
  test("the exact incident logs now classify as healthy", () => {
    const r = ask();
    assert.equal(r.healthy, true, r.reason);
    assert.match(r.reason, /healthy/);
  });

  test("the old predicate is what failed — the last matching line is the banner", () => {
    // Reproducing the previous logic against the same input, to show it was the
    // logic and not the monitor.
    const lines = INCIDENT_LOGS.split("\n").filter((l) => l.includes("[monitor:health]"));
    const last = lines[lines.length - 1]!;
    assert.ok(last.includes("Health tick"), "the last matching line is the banner");
    assert.equal(last.includes("healthy —"), false,
      "which is exactly why the old check said MONITOR_UNHEALTHY");
  });

  test("ordering is never trusted — every banner timestamp is parsed", () => {
    const shuffled = INCIDENT_LOGS.split("\n").reverse().join("\n");
    assert.equal(ask({ logs: shuffled }).healthy, true,
      "a healthy monitor must not depend on log delivery order");
  });
});

// ── 1-14. Health semantics ───────────────────────────────────────────────

describe("1-14. what counts as a live monitor", () => {
  test("1. a genuinely stopped monitor blocks production", () => {
    // Last tick three hours ago against an hourly cadence.
    const stale = [tick("2026-08-14T21:18:39.799Z"), healthy()].join("\n");
    const r = ask({ logs: stale });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /exceeds/);
    assert.match(r.reason, /cadence/);
  });

  test("2. a fresh healthy monitor permits readiness", () => {
    assert.equal(ask().healthy, true);
  });

  test("3/4/5/6. intentional health-only, AI-off, no scheduler is still healthy", () => {
    // The fixture IS that state: MONITOR_MODE=health_only, MONITOR_AI_ENABLED
    // =false, SCHEDULER_ENABLED unset — every scheduler line says SKIPPED_DISABLED.
    assert.ok(INCIDENT_LOGS.includes("SKIPPED_DISABLED"));
    assert.equal(ask().healthy, true,
      "a deliberately quiet monitor is not a dead one");
  });

  test("7. no monitor output at all fails closed", () => {
    const r = ask({ logs: "" });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /no \[monitor:health\] output/);
  });

  test("7. output with no tick banner fails closed", () => {
    const r = ask({ logs: healthy() });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /no health tick/);
  });

  test("8/9. the freshness boundary is exactly twice the cadence", () => {
    const at = (ms: number) => ask({
      logs: [tick("2026-08-15T00:00:00.000Z"), healthy()].join("\n"),
      now: new Date(new Date("2026-08-15T00:00:00.000Z").getTime() + ms),
    });
    assert.equal(at(2 * HOUR - 1000).healthy, true, "one missed tick is tolerated");
    assert.equal(at(2 * HOUR + 1000).healthy, false, "two missed ticks is a stopped monitor");
  });

  test("10. the threshold is derived from the monitor's own cadence", () => {
    const logs = [tick("2026-08-15T00:00:00.000Z"), healthy()].join("\n");
    const now = new Date("2026-08-15T00:50:00.000Z");   // 50 min later
    // Hourly cadence: fine. 15-minute cadence: two ticks missed, not fine.
    assert.equal(classifyMonitorHealth({ logs, channel: CH, intervalMs: HOUR, now }).healthy, true);
    assert.equal(classifyMonitorHealth({ logs, channel: CH, intervalMs: 15 * 60_000, now }).healthy, false);
  });

  test("an unknown cadence fails closed rather than guessing", () => {
    for (const intervalMs of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = ask({ intervalMs: intervalMs as number | null });
      assert.equal(r.healthy, false, `interval ${intervalMs} was accepted`);
      assert.match(r.reason, /poll interval is unknown/);
    }
  });

  test("11/12. another channel's monitor cannot answer for this one", () => {
    const wc = [tick("2026-08-15T00:18:40.096Z", "wet-circuit"), healthy("wet-circuit")].join("\n");
    const r = ask({ logs: wc });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /no health tick for ai-doom-scroll/);
  });

  test("a fresh tick for this channel plus another channel's verdict is not enough", () => {
    const mixed = [tick("2026-08-15T00:18:40.096Z"), healthy("wet-circuit")].join("\n");
    const r = ask({ logs: mixed });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /no healthy verdict for ai-doom-scroll/);
  });

  test("13. a fresh tick reporting findings is not masked by an older healthy line", () => {
    const withAlert = [
      tick("2026-08-14T23:18:39.998Z"), healthy(),
      tick("2026-08-15T00:18:40.096Z"),
      "[monitor:health] ALERT YOUTUBE_VIDEO_MISSING abc123: not found on the channel",
    ].join("\n");
    const r = ask({ logs: withAlert });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /ALERT/);
  });

  test("14. a tick with an unparseable timestamp is ignored, not trusted", () => {
    const bad = [`[monitor:health] ═══ Health tick (${CH}) at not-a-date ═══`, healthy()].join("\n");
    const r = ask({ logs: bad });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /no health tick/);
  });
});

// ── 15-20. Preflight consistency ─────────────────────────────────────────

describe("15-20. preflight and production readiness check different things", () => {
  const PRE = readFileSync("scripts/monday-preflight.ts", "utf8");
  const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");

  test("15/16. the divergence is real and deliberate, not a contradiction", () => {
    // monday-preflight asserts monitor CONFIGURATION — the variables that say
    // the monitor is in its safe mode. It never reads monitor output.
    assert.match(PRE, /MONITOR_MODE=health_only/);
    assert.match(PRE, /monitor AI disabled/);
    assert.ok(!PRE.includes("[monitor:health]"),
      "preflight does not inspect monitor liveness — that is why it passed 35/35");
    // The production control asserts monitor LIVENESS, which is a strictly
    // stronger claim and only matters when something is about to spend.
    assert.match(CTRL, /\[monitor:health\]/);
  });

  test("17/18. no tranche is a healthy resting state, and preflight never demands one", () => {
    assert.ok(!PRE.includes("trancheState") && !PRE.includes("NO_AUTHORIZATION"),
      "monday-preflight must not require live spend authorization");
    assert.match(CTRL, /"NOT_AUTHORIZED"/);
  });

  test("19/20. graduated AI Doom and PREPARED WC remain healthy at rest", () => {
    assert.match(PRE, /p\.status === "COMPLETED"/);
    assert.match(PRE, /p\.status === "PREPARED" \|\| p\.status === "ACTIVE"/);
  });
});

// ── Observability ────────────────────────────────────────────────────────

describe("the refusal now says why", () => {
  test("every verdict carries a human-readable reason", () => {
    const cases = [
      ask(),
      ask({ logs: "" }),
      ask({ intervalMs: null }),
      ask({ logs: [tick("2026-08-14T20:00:00.000Z"), healthy()].join("\n") }),
    ];
    for (const c of cases) assert.ok(c.reason.length > 10, JSON.stringify(c));
  });

  test("the reason reaches the operator on refusal", () => {
    const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.match(CTRL, /if \(r\.phase === "MONITOR_UNHEALTHY"\)/);
    assert.match(CTRL, /→ monitor: \$\{m\?\.detail/);
  });

  test("no force flag was added to work around it", () => {
    const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    for (const f of ["--force", "--ignore-monitor", "--skip-health", "SKIP_MONITOR"]) {
      assert.ok(!CTRL.includes(f), `${f} must not exist — the gate stays fail-closed`);
    }
  });
});
