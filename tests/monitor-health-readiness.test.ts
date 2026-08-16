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
    assert.match(r.reason, /0 active finding\(s\)/);
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
    assert.match(r.reason, /over the .* maximum/);
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
    assert.match(r.reason, /has not reported clean since the last finding|no health tick/,
      "another channel's healthy line does not clear this channel's tick");
  });

  test("13. a fresh tick reporting findings is not masked by an older healthy line", () => {
    const withAlert = [
      tick("2026-08-14T23:18:39.998Z"), healthy(),
      tick("2026-08-15T00:18:40.096Z"),
      "[monitor:health] ALERT YOUTUBE_VIDEO_MISSING abc123: not found on the channel",
    ].join("\n");
    const r = ask({ logs: withAlert });
    assert.equal(r.healthy, false);
    assert.match(r.reason, /has not reported clean since the last finding/);
    assert.match(r.reason, /ALERT/, "the operator is shown an example finding");
  });

  /**
   * The real RUN_FAILED alert from 2026-08-15. It is a true finding — a
   * production run did fail — and it correctly blocks the next run. What must
   * NOT happen is that it blocks forever: the monitor drops it after 24h, and
   * readiness has to follow, not stay stuck on a line still in the log buffer.
   */
  test("a resolved finding stops blocking once the monitor stops reporting it", () => {
    const during = [
      tick("2026-08-15T00:51:48.925Z"),
      "[monitor:health] ALERT RUN_FAILED 00959a09: terminal status FAILED",
    ].join("\n");
    assert.equal(ask({ logs: during, now: new Date("2026-08-15T00:55:00.000Z") }).healthy, false);

    // Later ticks are clean; the stale ALERT line is still in the buffer.
    const after = [
      "[monitor:health] ALERT RUN_FAILED 00959a09: terminal status FAILED",
      tick("2026-08-16T01:18:40.096Z"), healthy(),
    ].join("\n");
    assert.equal(ask({ logs: after, now: new Date("2026-08-16T01:20:00.000Z") }).healthy, true,
      "presence of an old ALERT line must not block production indefinitely");
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


// ── The Sunday 2026-08-16 refusal ────────────────────────────────────────

/**
 * The monitor was clean for thirteen consecutive hours and readiness still
 * refused:
 *
 *   24 of 37 recent health tick(s) reported findings — e.g. ALERT RUN_FAILED
 *   00959a09-…: terminal status FAILED at 2026-08-15T00:39:16.056Z
 *
 * Every one of those 24 ticks was correct at the time. The run really did fail,
 * and the monitor reports a failed run for `RECENT_RUN_WINDOW_MS` (24 h). Traced
 * against the real log buffer: the last tick to name it was 2026-08-15T23:51Z,
 * and the first tick after the window — 2026-08-16T00:51Z — was clean, as was
 * every tick since.
 *
 * So the monitor's finding computation was right. What was wrong was asking
 * "how many recent ticks ever had findings?" instead of "what does the latest
 * one say?". Aggregating history meant readiness could not recover until the
 * log buffer rolled, which is not a fact about the system's health.
 */
describe("current state, not history", () => {
  const T = (iso: string, id?: string) => id
    ? `[monitor:health] [tick ${id}] ═══ Health tick (${CH}) at ${iso} ═══`
    : tick(iso);
  const OK = (id?: string) => id
    ? `[monitor:health] [tick ${id}] ${CH}: healthy — 0 scheduled video(s) checked`
    : healthy();
  const AL = (id?: string) => (id ? `[monitor:health] [tick ${id}] ` : "[monitor:health] ") +
    "ALERT RUN_FAILED 00959a09: terminal status FAILED at 2026-08-15T00:39:16.056Z";

  /** 24 alerting ticks then 13 clean ones — the real Sunday shape. */
  function sundayBuffer(tagged: boolean): string {
    const out: string[] = [];
    let n = 0;
    const id = () => (tagged ? (++n).toString(16).padStart(8, "0") : undefined);
    for (let h = 0; h < 24; h++) {
      const k = id();
      out.push(T(`2026-08-15T${String(h).padStart(2, "0")}:51:00.000Z`, k), AL(k));
    }
    for (let h = 0; h < 13; h++) {
      const k = id();
      out.push(T(`2026-08-16T${String(h).padStart(2, "0")}:51:00.000Z`, k), OK(k));
    }
    return out.join("\n");
  }
  const SUNDAY_NOW = new Date("2026-08-16T13:40:00.000Z");
  const askSunday = (logs: string, now = SUNDAY_NOW) =>
    classifyMonitorHealth({ logs, channel: CH, intervalMs: HOUR, now });

  test("1. the exact Sunday buffer is HEALTHY", () => {
    for (const tagged of [false, true]) {
      const r = askSunday(sundayBuffer(tagged));
      assert.equal(r.healthy, true, `tagged=${tagged}: ${r.reason}`);
    }
  });

  test("2. the history is still reported, as diagnostics", () => {
    assert.match(askSunday(sundayBuffer(true)).reason, /historical/);
  });

  test("3. old ALERTs do not poison a newer clean tick", () => {
    const r = askSunday(sundayBuffer(true));
    assert.equal(r.healthy, true);
    assert.match(r.reason, /0 active finding\(s\)/);
  });

  test("4/22. tagged logs survive arbitrary reordering", () => {
    const base = sundayBuffer(true).split("\n");
    for (const shuffled of [base.slice().reverse(), base.slice().sort(() => 0.5 - Math.random())]) {
      assert.equal(askSunday(shuffled.join("\n")).healthy, true,
        "tick ids exist precisely so order cannot change the answer");
    }
  });

  test("5/23/25/26. channel scoping stays exact", () => {
    const wc = sundayBuffer(true).replaceAll(CH, "wet-circuit");
    assert.equal(askSunday(wc).healthy, false, "a WC tick cannot satisfy AI Doom");
    assert.equal(classifyMonitorHealth({
      logs: sundayBuffer(true), channel: "wet-circuit", intervalMs: HOUR, now: SUNDAY_NOW,
    }).healthy, false, "an AI Doom tick cannot satisfy WC");
  });

  // ── 6-9. A current alert still blocks ───────────────────────────────
  test("6. clean history then a newest tick with an ALERT is UNHEALTHY", () => {
    const logs = [T("2026-08-16T11:51:00.000Z", "00000001"), OK("00000001"),
                  T("2026-08-16T12:51:00.000Z", "00000002"), AL("00000002")].join("\n");
    const r = askSunday(logs);
    assert.equal(r.healthy, false);
    assert.match(r.reason, /reported findings/);
    assert.match(r.reason, /RUN_FAILED/);
  });

  test("7/8. an alert on the newest tick blocks even with alerting history", () => {
    const logs = [...sundayBuffer(true).split("\n"),
      T("2026-08-16T13:00:00.000Z", "000000ff"),
      "[monitor:health] [tick 000000ff] ALERT YOUTUBE_VIDEO_MISSING zz: not found"].join("\n");
    const r = askSunday(logs);
    assert.equal(r.healthy, false);
    assert.match(r.reason, /YOUTUBE_VIDEO_MISSING/);
  });

  test("9. once the monitor stops reporting it, history alone does not block", () => {
    // Exactly the Sunday case, stated as the requirement.
    assert.equal(askSunday(sundayBuffer(true)).healthy, true);
  });

  // ── 17-21. Partial ticks ────────────────────────────────────────────
  test("17. a banner with no verdict is never read as clean", () => {
    const logs = [T("2026-08-16T11:51:00.000Z", "00000001"), OK("00000001"),
                  T("2026-08-16T12:51:00.000Z", "00000002")].join("\n");
    const r = askSunday(logs);
    // The in-flight tick is not complete, so the newest COMPLETED tick decides.
    assert.equal(r.healthy, true, r.reason);
    assert.match(r.reason, /11:51/, "it must judge the completed tick, not the in-flight one");
  });

  test("18. an in-flight tick cannot erase an active alert", () => {
    const logs = [T("2026-08-16T11:51:00.000Z", "00000001"), AL("00000001"),
                  T("2026-08-16T12:51:00.000Z", "00000002")].join("\n");
    const r = askSunday(logs);
    assert.equal(r.healthy, false);
    assert.match(r.reason, /RUN_FAILED/);
  });

  test("19. an orphaned verdict with no tick satisfies nothing", () => {
    assert.equal(askSunday(OK("000000aa")).healthy, false);
  });

  test("20. duplicate lines do not change the verdict", () => {
    const once = sundayBuffer(true);
    const twice = once.split("\n").flatMap((l) => [l, l]).join("\n");
    assert.equal(askSunday(twice).healthy, askSunday(once).healthy);
  });

  test("21. interleaved ticks stay correctly grouped by id", () => {
    // Two ticks whose lines are woven together; only the newer has an alert.
    const logs = [
      T("2026-08-16T11:51:00.000Z", "00000001"),
      T("2026-08-16T12:51:00.000Z", "00000002"),
      OK("00000001"),
      AL("00000002"),
    ].join("\n");
    const r = askSunday(logs);
    assert.equal(r.healthy, false, "the alert belongs to the NEWER tick");
    assert.match(r.reason, /12:51/);
  });

  test("the reverse interleaving is also grouped correctly", () => {
    const logs = [
      T("2026-08-16T11:51:00.000Z", "00000001"),
      T("2026-08-16T12:51:00.000Z", "00000002"),
      AL("00000001"),
      OK("00000002"),
    ].join("\n");
    const r = askSunday(logs);
    assert.equal(r.healthy, true, "the alert belongs to the OLDER tick");
    assert.match(r.reason, /12:51/);
  });

  // ── 10-16. Freshness, unchanged ─────────────────────────────────────
  test("10/11. the newest completed tick must be fresh", () => {
    const fresh = [T("2026-08-16T12:51:00.000Z", "00000001"), OK("00000001")].join("\n");
    assert.equal(askSunday(fresh).healthy, true);
    const stale = [T("2026-08-16T09:00:00.000Z", "00000001"), OK("00000001")].join("\n");
    const r = askSunday(stale);
    assert.equal(r.healthy, false);
    assert.match(r.reason, /over the 120 min maximum/);
  });

  test("12/13/14. missing, unparseable and unknown-cadence all fail closed", () => {
    assert.equal(askSunday("").healthy, false);
    assert.equal(askSunday(`[monitor:health] [tick 00000001] ═══ Health tick (${CH}) at nope ═══`).healthy, false);
    assert.equal(classifyMonitorHealth({
      logs: sundayBuffer(true), channel: CH, intervalMs: null, now: SUNDAY_NOW }).healthy, false);
  });

  test("15/16. the threshold still tracks the configured cadence", () => {
    const logs = [T("2026-08-16T12:51:00.000Z", "00000001"), OK("00000001")].join("\n");
    const now = new Date("2026-08-16T14:20:00.000Z");   // 89 min later
    assert.equal(classifyMonitorHealth({ logs, channel: CH, intervalMs: HOUR, now }).healthy, true);
    assert.equal(classifyMonitorHealth({ logs, channel: CH, intervalMs: 30 * 60_000, now }).healthy, false);
  });
});
