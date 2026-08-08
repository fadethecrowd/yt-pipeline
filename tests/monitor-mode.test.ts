import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseMonitorMode, modePermitsWork, modePermitsLegacy, MonitorModeError,
} from "../packages/monitor/src/lib/monitorMode";
import { runHealthTick, startHealthLoop, formatFindings } from "../packages/monitor/src/healthTick";
import type { HealthDeps } from "../packages/monitor/src/healthTick";
import type { ScheduledVideo, YtView } from "../packages/monitor/src/lib/videoHealth";
import { GO_LIVE_GRACE_MS } from "../packages/monitor/src/lib/videoHealth";

/**
 * The monitor's master execution mode.
 *
 * MONITOR_AI_ENABLED was never a kill switch — it gated Claude calls only, so a
 * monitor with AI "disabled" still started, ticked hourly, read YouTube, ran
 * lifecycle and Reddit logic, announced itself on Telegram, and carried an
 * executor holding videos.update and comments.insert. These tests pin the real
 * control, and pin that HEALTH_ONLY cannot reach any of that machinery.
 */

const INDEX = readFileSync("packages/monitor/src/index.ts", "utf8");
const HEALTH_TICK = readFileSync("packages/monitor/src/healthTick.ts", "utf8");
const HEALTH_DEPS = readFileSync("packages/monitor/src/healthDeps.ts", "utf8");
const MODE = readFileSync("packages/monitor/src/lib/monitorMode.ts", "utf8");

/**
 * Code with comments removed. These modules describe in prose exactly what they
 * must not touch, so an assertion over raw text would match its own
 * documentation. What matters is the executable surface.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const HEALTH_TICK_CODE = stripComments(HEALTH_TICK);
const HEALTH_DEPS_CODE = stripComments(HEALTH_DEPS);

const DUE = new Date("2026-08-12T19:00:00.000Z");

// ── DISABLED ─────────────────────────────────────────────────────────────

describe("1-3. fail-closed mode parsing", () => {
  test("1. unset or empty is DISABLED", () => {
    assert.equal(parseMonitorMode(undefined), "DISABLED");
    assert.equal(parseMonitorMode(""), "DISABLED");
    assert.equal(parseMonitorMode("   "), "DISABLED");
  });

  test("2. exact 'disabled' is DISABLED", () => {
    assert.equal(parseMonitorMode("disabled"), "DISABLED");
    assert.equal(parseMonitorMode(" disabled "), "DISABLED");
  });

  test("only exact 'health_only' and 'active' enable work", () => {
    assert.equal(parseMonitorMode("health_only"), "HEALTH_ONLY");
    assert.equal(parseMonitorMode("active"), "ACTIVE");
  });

  test("3. anything unrecognised throws rather than falling back", () => {
    for (const bad of ["Active", "ACTIVE", "enabled", "on", "true", "healthonly",
                       "health-only", "activ", "1", "yes"]) {
      assert.throws(() => parseMonitorMode(bad), MonitorModeError, `"${bad}" must fail closed`);
    }
  });

  test("a typo can never silently enable a live monitor", () => {
    // The dangerous failure would be treating an unknown value as ACTIVE.
    for (const bad of ["activee", "aktive", "ACTIVE "]) {
      assert.throws(() => parseMonitorMode(bad));
    }
  });

  test("mode predicates", () => {
    assert.equal(modePermitsWork("DISABLED"), false);
    assert.equal(modePermitsWork("HEALTH_ONLY"), true);
    assert.equal(modePermitsWork("ACTIVE"), true);
    assert.equal(modePermitsLegacy("HEALTH_ONLY"), false);
    assert.equal(modePermitsLegacy("ACTIVE"), true);
    assert.equal(modePermitsLegacy("DISABLED"), false);
  });
});

describe("4-10. the DISABLED boundary precedes every side effect", () => {
  /** Everything before the gate, in source order. */
  const gateIdx = INDEX.indexOf("const mode = parseMonitorMode(process.env.MONITOR_MODE)");
  const exitIdx = INDEX.indexOf('monitor execution disabled; exiting');

  test("the gate is the first statement in main()", () => {
    const mainIdx = INDEX.indexOf("async function main(): Promise<void> {");
    assert.ok(gateIdx > mainIdx, "gate is inside main");
    const between = INDEX.slice(mainIdx, gateIdx);
    // Only comments may precede it.
    for (const t of ["await ", "env()", "startBot", "tick(", "setInterval"]) {
      assert.ok(!between.includes(t), `${t} must not precede the gate`);
    }
  });

  test("4. verifyChannel comes after the gate", () => {
    assert.ok(INDEX.indexOf("await verifyChannel(") > exitIdx);
  });

  test("5. startBot comes after the gate", () => {
    assert.ok(INDEX.indexOf("startBot()") > exitIdx);
  });

  test("6/7. config parsing and channel queries come after the gate", () => {
    assert.ok(INDEX.indexOf("const config = env();") > exitIdx);
    assert.ok(INDEX.indexOf("goalDb.find()") > exitIdx);
  });

  test("8/9. the first tick and the interval come after the gate", () => {
    assert.ok(INDEX.indexOf("await tick();") > exitIdx);
    assert.ok(INDEX.indexOf("setInterval(") > exitIdx);
  });

  test("10. DISABLED exits cleanly with code 0", () => {
    const block = INDEX.slice(gateIdx, INDEX.indexOf("const config = env();"));
    assert.match(block, /process\.exit\(0\)/);
    assert.match(block, /prisma\.\$disconnect\(\)/);
  });

  test("the log line is unambiguous", () => {
    assert.match(INDEX, /monitor execution disabled; exiting without starting any monitoring work/);
  });

  test("MONITOR_AI_ENABLED is not repurposed as the master switch", () => {
    const gateBlock = INDEX.slice(gateIdx, INDEX.indexOf("const config = env();"));
    assert.ok(!gateBlock.includes("MONITOR_AI_ENABLED"));
    // It still exists as a separate AI permission.
    assert.match(INDEX, /MONITOR_AI_ENABLED/);
  });
});

// ── HEALTH_ONLY ──────────────────────────────────────────────────────────

const vid = (over: Partial<ScheduledVideo> = {}): ScheduledVideo => ({
  id: "row-1", youtubeId: "yt-1", status: "UPLOADED", scheduledAt: DUE, ...over,
});
const ytv = (over: Partial<YtView> = {}): YtView => ({
  exists: true, privacyStatus: "private", publishAt: DUE.toISOString(), ...over,
});

interface Fake { deps: HealthDeps; alerts: string[]; calls: string[] }
function makeFake(o: {
  videos?: ScheduledVideo[]; yt?: YtView | null; unresolved?: number;
  runs?: { id: string; status: string; startTime: Date; endTime: Date | null }[];
  budgets?: { key: string; limit: number; reserved: number }[];
  activeRuns?: number;
  pilots?: { pilotId: string; status: string; successCount: number; maxSuccesses: number; successVideoIds: string[] }[];
  now?: Date;
} = {}): Fake {
  const alerts: string[] = [];
  const calls: string[] = [];
  const deps: HealthDeps = {
    async scheduledVideos() { calls.push("scheduledVideos"); return o.videos ?? []; },
    async ytView() { calls.push("ytView"); return o.yt === undefined ? ytv() : o.yt; },
    async unresolvedIntentCount() { calls.push("intents"); return o.unresolved ?? 0; },
    async recentRuns() { calls.push("runs"); return o.runs ?? []; },
    async budgets() { calls.push("budgets"); return o.budgets ?? [{ key: "c/PRODUCTION", limit: 0, reserved: 0 }]; },
    async activeRunCount() { return o.activeRuns ?? 0; },
    async pilots() { calls.push("pilots"); return o.pilots ?? []; },
    async sendAlert(t) { alerts.push(t); },
    now: () => o.now ?? new Date(DUE.getTime() - 86_400_000),
    log: () => {},
  };
  return { deps, alerts, calls };
}

describe("11-17. HEALTH_ONLY runs only the health path", () => {
  test("11/12. the health branch never calls the legacy tick", () => {
    const branch = INDEX.slice(
      INDEX.indexOf('if (mode === "HEALTH_ONLY")'),
      INDEX.indexOf('MONITOR_MODE=active'),
    );
    assert.match(branch, /startHealthLoop\(/);
    assert.ok(!branch.includes("await tick()"), "must not run the legacy tick");
    assert.ok(!branch.includes("executeDecisions"));
    assert.ok(!branch.includes("startBot"));
    assert.match(branch, /return;/, "health branch returns before legacy setup");
  });

  test("13-17. the health modules import no AI, executor, lifecycle or Reddit", () => {
    for (const src of [HEALTH_TICK_CODE, HEALTH_DEPS_CODE]) {
      for (const forbidden of [
        "aiCallBudget", "decisionEngine", "executeDecisions", "executor",
        "lifecycleDetector", "redditPoster", "redditScraper", "commentScraper",
        "anthropic", "Anthropic", "poller",
      ]) {
        assert.ok(!src.includes(forbidden), `health path must not reference ${forbidden}`);
      }
    }
  });

  test("18. a correctly scheduled private video produces no alert", async () => {
    const f = makeFake({ videos: [vid()], yt: ytv() });
    const r = await runHealthTick("ai-doom-scroll", f.deps);
    assert.equal(r.report.findings.length, 0);
    assert.equal(r.alerted, false);
    assert.equal(f.alerts.length, 0);
  });

  test("19. failure to go live produces exactly one deterministic alert", async () => {
    const f = makeFake({
      videos: [vid()], yt: ytv({ privacyStatus: "private" }),
      now: new Date(DUE.getTime() + GO_LIVE_GRACE_MS + 60_000),
    });
    const r = await runHealthTick("ai-doom-scroll", f.deps);
    assert.deepEqual(r.report.findings.map((x) => x.code), ["FAILED_TO_GO_LIVE"]);
    assert.equal(f.alerts.length, 1);
    assert.match(f.alerts[0], /FAILED_TO_GO_LIVE/);
  });

  test("20. publishAt divergence produces one alert", async () => {
    const f = makeFake({ videos: [vid()], yt: ytv({ publishAt: "2026-08-14T19:00:00.000Z" }) });
    const r = await runHealthTick("wet-circuit", f.deps);
    assert.deepEqual(r.report.findings.map((x) => x.code), ["PUBLISH_AT_DIVERGED"]);
    assert.equal(f.alerts.length, 1);
  });

  test("21. an unresolved upload intent produces one alert", async () => {
    const f = makeFake({ unresolved: 1 });
    const r = await runHealthTick("ai-doom-scroll", f.deps);
    assert.deepEqual(r.report.findings.map((x) => x.code), ["UNRESOLVED_UPLOAD_INTENT"]);
    assert.equal(f.alerts.length, 1);
  });

  test("22. today's PREPARED pilot produces no alert", async () => {
    const f = makeFake({
      pilots: [{ pilotId: "ai-doom-private-pilot-1", status: "PREPARED",
        successCount: 0, maxSuccesses: 1, successVideoIds: [] }],
    });
    const r = await runHealthTick("ai-doom-scroll", f.deps);
    assert.deepEqual(r.report.findings, []);
    assert.equal(f.alerts.length, 0);
  });

  test("no YouTube read is attempted for a video with no youtubeId", async () => {
    const f = makeFake({ videos: [vid({ youtubeId: null })] });
    await runHealthTick("ai-doom-scroll", f.deps);
    assert.ok(!f.calls.includes("ytView"));
  });

  test("silence is the healthy outcome — the alert transport is untouched", async () => {
    const f = makeFake();
    const r = await runHealthTick("wet-circuit", f.deps);
    assert.equal(r.alerted, false);
    assert.equal(f.alerts.length, 0);
  });
});

describe("10/23/24. write boundary and channel isolation", () => {
  test("the health path imports no YouTube write capability", () => {
    for (const t of ["videos.update", "comments.insert", "videos.insert", "playlistItems"]) {
      assert.ok(!HEALTH_TICK_CODE.includes(t), `healthTick must not reference ${t}`);
      assert.ok(!HEALTH_DEPS_CODE.includes(t), `healthDeps must not reference ${t}`);
    }
  });

  test("healthTick imports nothing but the pure evaluator", () => {
    const imports = [...HEALTH_TICK_CODE.matchAll(/from "(.*?)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(imports)].sort(), ["./lib/videoHealth"]);
  });

  test("the only YouTube call in the health wiring is a list read", () => {
    const calls = [...HEALTH_DEPS_CODE.matchAll(/youtube\(\)\.[a-zA-Z.]+/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(calls)], ["youtube().videos.list"]);
  });

  test("no pipeline trigger anywhere in the health path", () => {
    for (const src of [HEALTH_TICK_CODE, HEALTH_DEPS_CODE]) {
      for (const t of ["runPipeline", "topicDiscovery", "voiceover", "videoAssembly"]) {
        assert.ok(!src.includes(t));
      }
    }
  });

  test("23/24. channel selects the model once, so neither channel sees the other", () => {
    assert.match(HEALTH_DEPS, /channel === "ai-doom-scroll" \? "video" : "wcVideo"/);
    // Every scoped query filters by the channel it was given.
    assert.match(HEALTH_DEPS, /where: \{ channel, startTime/);
    assert.match(HEALTH_DEPS, /where: \{ channel, NOT: \{ testStage: "DIAGNOSTIC" \} \}/);
    assert.match(HEALTH_DEPS, /where: \{ channel, endTime: null \}/);
    assert.match(HEALTH_DEPS, /where: \{ channel \}/);
  });

  test("a report only ever concerns the channel it was given", async () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const r = await runHealthTick(ch, makeFake().deps);
      assert.equal(r.report.channel, ch);
    }
  });
});

describe("25/26. polling and single flight", () => {
  test("25. the interval is whatever POLL_INTERVAL_MS says — unchanged at 1h", () => {
    assert.match(INDEX, /startHealthLoop\(config\.CHANNEL, deps, config\.POLL_INTERVAL_MS\)/);
  });

  test("26. ticks cannot overlap", async () => {
    let running = 0, maxConcurrent = 0;
    const f = makeFake();
    f.deps.scheduledVideos = async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 30));
      running--; return [];
    };
    const loop = startHealthLoop("ai-doom-scroll", f.deps, 1);
    await Promise.all([loop.runNow(), loop.runNow(), loop.runNow()]);
    loop.stop();
    assert.equal(maxConcurrent, 1, "a second tick must be skipped, not queued");
  });

  test("a failing tick is surfaced but never escalates", async () => {
    const f = makeFake();
    f.deps.scheduledVideos = async () => { throw new Error("db down"); };
    const loop = startHealthLoop("wet-circuit", f.deps, 10_000);
    await loop.runNow();  // must not throw
    loop.stop();
    assert.equal(f.alerts.length, 0);
  });
});

describe("27-32. ACTIVE and isolation", () => {
  test("27. exact 'active' retains the legacy entry path", () => {
    assert.equal(parseMonitorMode("active"), "ACTIVE");
    assert.match(INDEX, /MONITOR_MODE=active — full legacy monitoring/);
    // The legacy setup still follows.
    assert.ok(INDEX.indexOf("startBot()") > INDEX.indexOf("MONITOR_MODE=active"));
    assert.ok(INDEX.indexOf("await tick();") > INDEX.indexOf("MONITOR_MODE=active"));
  });

  test("28/29. MONITOR_AI_ENABLED remains a separate permission inside ACTIVE", () => {
    assert.match(INDEX, /if \(config\.MONITOR_AI_ENABLED\)/);
    const aiBudget = readFileSync("packages/monitor/src/lib/aiCallBudget.ts", "utf8");
    assert.match(aiBudget, /if \(!config\.MONITOR_AI_ENABLED\)/);
  });

  test("30. HEALTH_ONLY returns before any legacy setup runs", () => {
    const branch = INDEX.slice(
      INDEX.indexOf('if (mode === "HEALTH_ONLY")'),
      INDEX.indexOf('MONITOR_MODE=active'),
    );
    const ret = branch.lastIndexOf("return;");
    assert.ok(ret > 0, "the health branch must return");
    assert.ok(!branch.slice(0, ret).includes("startBot"));
  });

  test("31. no pipeline runtime imports monitor code", () => {
    for (const f of [
      "src/index.ts", "src/pipeline.ts",
      "packages/wc-pipeline/src/index.ts", "packages/wc-pipeline/src/pipeline.ts",
      "packages/pipeline-core/src/index.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!src.includes("packages/monitor"), f);
      assert.ok(!src.includes("healthTick"), f);
      assert.ok(!src.includes("monitorMode"), f);
    }
  });

  test("32. the alert transport is injected, so tests never send", () => {
    assert.match(HEALTH_TICK, /sendAlert\(text: string\): Promise<void>/);
    // healthTick itself imports no transport.
    assert.ok(!HEALTH_TICK_CODE.includes("telegram"));
  });

  test("formatFindings renders every finding", () => {
    const text = formatFindings("ai-doom-scroll", [
      { code: "X", severity: "ALERT", subject: "s", detail: "d" },
      { code: "Y", severity: "WARN", subject: "t", detail: "e" },
    ]);
    assert.match(text, /ai-doom-scroll/);
    assert.match(text, /2 finding\(s\)/);
    assert.match(text, /\[ALERT\] X/);
    assert.match(text, /\[WARN\] Y/);
  });

  test("the mode module documents why AI_ENABLED was never the switch", () => {
    assert.match(MODE, /never a kill switch/);
    assert.match(MODE, /Fail-closed/);
  });
});
