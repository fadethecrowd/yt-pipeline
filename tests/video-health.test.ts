import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateChannelHealth, checkScheduledVideo, checkUploadSafety,
  checkPipelineHealth, checkIdleBudget, checkPilotConsistency, GO_LIVE_GRACE_MS,
} from "../packages/monitor/src/lib/videoHealth";
import type { ScheduledVideo, YtView, HealthInput } from "../packages/monitor/src/lib/videoHealth";

/**
 * First-week video health.
 *
 * The existing monitor watches performance, not delivery. It never reads
 * uploadIntent, never compares YouTube's publishAt to the durable scheduledAt,
 * and never notices a scheduled video that stayed private. These checks cover
 * exactly that gap, and — just as importantly — stay silent about the states we
 * are deliberately sitting in before launch.
 */

const HEALTH = readFileSync("packages/monitor/src/lib/videoHealth.ts", "utf8");
const MONITOR_INDEX = readFileSync("packages/monitor/src/index.ts", "utf8");

const DUE = new Date("2026-08-10T19:00:00.000Z");
const vid = (over: Partial<ScheduledVideo> = {}): ScheduledVideo => ({
  id: "row-1", youtubeId: "yt-1", status: "UPLOADED", scheduledAt: DUE, ...over,
});
const yt = (over: Partial<YtView> = {}): YtView => ({
  exists: true, privacyStatus: "private", publishAt: DUE.toISOString(), ...over,
});
const codes = (f: { code: string }[]) => f.map((x) => x.code).sort();

describe("2/3. correctly scheduled and still private before go-live is healthy", () => {
  test("exact publishAt match, before the slot → no findings", () => {
    const before = new Date(DUE.getTime() - 60 * 60 * 1000);
    assert.deepEqual(checkScheduledVideo(vid(), yt(), before), []);
  });

  test("a video with no scheduledAt is not this check's business", () => {
    assert.deepEqual(checkScheduledVideo(vid({ scheduledAt: null }), yt(), DUE), []);
  });
});

describe("4. divergence alerts", () => {
  test("publishAt differs from durable scheduledAt", () => {
    const before = new Date(DUE.getTime() - 3600_000);
    const f = checkScheduledVideo(vid(), yt({ publishAt: "2026-08-12T19:00:00.000Z" }), before);
    assert.deepEqual(codes(f), ["PUBLISH_AT_DIVERGED"]);
    assert.equal(f[0].severity, "ALERT");
  });

  test("YouTube carries no publishAt at all", () => {
    const before = new Date(DUE.getTime() - 3600_000);
    assert.deepEqual(codes(checkScheduledVideo(vid(), yt({ publishAt: null }), before)),
      ["PUBLISH_AT_MISSING"]);
  });

  test("public before its slot", () => {
    const before = new Date(DUE.getTime() - 3600_000);
    const f = checkScheduledVideo(vid(), yt({ privacyStatus: "public", publishAt: null }), before);
    assert.ok(f.some((x) => x.code === "PUBLIC_BEFORE_SCHEDULE"));
  });
});

describe("5/6/7. go-live grace behaviour", () => {
  test("5. after the slot but inside grace → silent", () => {
    const inside = new Date(DUE.getTime() + GO_LIVE_GRACE_MS - 1000);
    assert.deepEqual(checkScheduledVideo(vid(), yt({ privacyStatus: "private" }), inside), []);
  });

  test("6. after grace, still private → alert", () => {
    const after = new Date(DUE.getTime() + GO_LIVE_GRACE_MS + 1000);
    const f = checkScheduledVideo(vid(), yt({ privacyStatus: "private" }), after);
    assert.deepEqual(codes(f), ["FAILED_TO_GO_LIVE"]);
  });

  test("7. after grace, public → healthy", () => {
    const after = new Date(DUE.getTime() + GO_LIVE_GRACE_MS + 1000);
    assert.deepEqual(checkScheduledVideo(vid(), yt({ privacyStatus: "public", publishAt: null }), after), []);
  });

  test("the grace boundary is exact", () => {
    const at = new Date(DUE.getTime() + GO_LIVE_GRACE_MS);
    assert.deepEqual(codes(checkScheduledVideo(vid(), yt(), at)), ["FAILED_TO_GO_LIVE"]);
    const justBefore = new Date(DUE.getTime() + GO_LIVE_GRACE_MS - 1);
    assert.deepEqual(checkScheduledVideo(vid(), yt(), justBefore), []);
  });

  test("the grace period is an operational constant, documented as such", () => {
    assert.equal(GO_LIVE_GRACE_MS, 15 * 60 * 1000);
    assert.match(HEALTH, /OPERATIONAL constant, not a content or business threshold/);
  });

  test("unlisted after grace also alerts", () => {
    const after = new Date(DUE.getTime() + GO_LIVE_GRACE_MS + 1000);
    assert.deepEqual(codes(checkScheduledVideo(vid(), yt({ privacyStatus: "unlisted" }), after)),
      ["FAILED_TO_GO_LIVE"]);
  });
});

describe("8. missing YouTube video", () => {
  test("a scheduled row whose video does not exist alerts", () => {
    assert.deepEqual(codes(checkScheduledVideo(vid(), { exists: false, privacyStatus: null, publishAt: null }, DUE)),
      ["YOUTUBE_VIDEO_MISSING"]);
    assert.deepEqual(codes(checkScheduledVideo(vid(), null, DUE)), ["YOUTUBE_VIDEO_MISSING"]);
  });

  test("scheduled with no youtubeId alerts", () => {
    assert.deepEqual(codes(checkScheduledVideo(vid({ youtubeId: null }), yt(), DUE)),
      ["SCHEDULED_WITHOUT_YOUTUBE_ID"]);
  });
});

describe("9/10/11. intents, runs and budgets", () => {
  test("9. an unresolved upload intent alerts", () => {
    assert.deepEqual(codes(checkUploadSafety(2)), ["UNRESOLVED_UPLOAD_INTENT"]);
    assert.deepEqual(checkUploadSafety(0), []);
  });

  test("12. a failed recent run alerts", () => {
    const runs = [{ id: "r1", status: "FAILED", startTime: DUE, endTime: DUE }];
    assert.deepEqual(codes(checkPipelineHealth(runs, DUE)), ["RUN_FAILED"]);
  });

  test("a stuck active run alerts, a fresh one does not", () => {
    const now = new Date(DUE.getTime() + 2 * 3600_000);
    assert.deepEqual(codes(checkPipelineHealth([{ id: "r", status: "RUNNING", startTime: DUE, endTime: null }], now)),
      ["RUN_STUCK"]);
    const fresh = new Date(DUE.getTime() + 60_000);
    assert.deepEqual(checkPipelineHealth([{ id: "r", status: "RUNNING", startTime: DUE, endTime: null }], fresh), []);
  });

  test("a successful completed run is silent", () => {
    assert.deepEqual(checkPipelineHealth([{ id: "r", status: "SUCCESS", startTime: DUE, endTime: DUE }], DUE), []);
  });

  test("10/11. stale reservation and open budget while idle alert", () => {
    assert.deepEqual(codes(checkIdleBudget([{ key: "a/PRODUCTION", limit: 0, reserved: 4000 }], 0)),
      ["STALE_RESERVATION"]);
    assert.deepEqual(codes(checkIdleBudget([{ key: "a/PRODUCTION", limit: 4164, reserved: 0 }], 0)),
      ["BUDGET_OPEN_WHILE_IDLE"]);
    // With a run in flight both are expected, not incidents.
    assert.deepEqual(checkIdleBudget([{ key: "a/PRODUCTION", limit: 4164, reserved: 4000 }], 1), []);
    assert.deepEqual(checkIdleBudget([{ key: "a/PRODUCTION", limit: 0, reserved: 0 }], 0), []);
  });
});

describe("13/14/15/16. pilots — designed states never alert", () => {
  const base = { pilotId: "p", successCount: 0, maxSuccesses: 1, successVideoIds: [] as string[] };

  test("13. a PREPARED pilot does not alert", () => {
    assert.deepEqual(checkPilotConsistency({ ...base, status: "PREPARED" }), []);
  });

  test("14. a valid ACTIVE pilot does not alert", () => {
    assert.deepEqual(checkPilotConsistency({ ...base, status: "ACTIVE" }), []);
  });

  test("15. a cap-consistent used pilot does not alert", () => {
    assert.deepEqual(checkPilotConsistency({
      pilotId: "p", status: "ACTIVE", successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] }), []);
  });

  test("16. impossible pilot arithmetic alerts", () => {
    assert.deepEqual(codes(checkPilotConsistency({
      pilotId: "p", status: "ACTIVE", successCount: 2, maxSuccesses: 1, successVideoIds: ["a", "b"] })),
      ["PILOT_CAP_EXCEEDED"]);
    assert.deepEqual(codes(checkPilotConsistency({
      pilotId: "p", status: "ACTIVE", successCount: 1, maxSuccesses: 3, successVideoIds: ["a", "b"] })),
      ["PILOT_COUNT_MISMATCH"]);
  });

  test("privacy, PREPARED-ness and caps are never treated as incidents", () => {
    assert.ok(!HEALTH.includes('"PILOT_PREPARED"'));
    assert.ok(!HEALTH.includes('"PILOT_PRIVATE"'));
    assert.match(HEALTH, /designed states, not incidents/);
  });
});

describe("1/17/18/19/20. current pre-launch state and isolation", () => {
  const preLaunch = (channel: string): HealthInput => ({
    channel,
    scheduled: [],                 // no future scheduled videos on either channel
    unresolvedIntents: 0,
    runs: [],
    budgets: [{ key: `${channel}/PRODUCTION`, limit: 0, reserved: 0 }],
    activeRuns: 0,
    pilots: [{ pilotId: `${channel}-pilot`, status: "PREPARED", successCount: 0, maxSuccesses: 1, successVideoIds: [] }],
    now: new Date("2026-08-08T16:00:00Z"),
  });

  test("1. today's exact pre-launch state produces ZERO findings on both channels", () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const r = evaluateChannelHealth(preLaunch(ch));
      assert.deepEqual(r.findings, [], `${ch} must not alert merely for being pre-launch`);
      assert.equal(r.healthy, true);
    }
  });

  test("17/18. a report only ever concerns the channel it was given", () => {
    const r = evaluateChannelHealth(preLaunch("ai-doom-scroll"));
    assert.equal(r.channel, "ai-doom-scroll");
    // The module hardcodes no channel of its own.
    assert.ok(!HEALTH.includes('"ai-doom-scroll"'));
    assert.ok(!HEALTH.includes('"wet-circuit"'));
  });

  test("19. the module performs no YouTube call at all, let alone a write", () => {
    // Prose mentions YouTube; what must be absent is any client or call site.
    for (const t of [
      "videos.update", "videos.insert", "comments.insert", "playlistItems",
      "googleapis", "buildYouTubeClient", "import ",
    ]) {
      assert.ok(!HEALTH.includes(t), `videoHealth must not reference ${t}`);
    }
    // It receives an already-read view rather than fetching one.
    assert.match(HEALTH, /export interface YtView/);
  });

  test("20. it triggers no pipeline work and writes no database row", () => {
    for (const t of ["prisma", "runPipeline", ".update(", ".create(", ".delete("]) {
      assert.ok(!HEALTH.includes(t), `videoHealth must not reference ${t}`);
    }
  });

  test("it is not wired into the live monitor tick", () => {
    // The monitor services are running. Adding behaviour to them is a separate,
    // controlled decision, so this module is consumed by a local script instead.
    assert.ok(!MONITOR_INDEX.includes("videoHealth"));
    assert.ok(!MONITOR_INDEX.includes("evaluateChannelHealth"));
  });

  test("evaluation is pure — same input, same output", () => {
    const input = preLaunch("wet-circuit");
    assert.deepEqual(evaluateChannelHealth(input), evaluateChannelHealth(input));
  });

  test("a fully broken channel surfaces every category at once", () => {
    const now = new Date(DUE.getTime() + 3600_000);
    const r = evaluateChannelHealth({
      channel: "x",
      scheduled: [{ video: vid(), yt: yt({ privacyStatus: "private" }) }],
      unresolvedIntents: 1,
      runs: [{ id: "r", status: "FAILED", startTime: DUE, endTime: DUE }],
      budgets: [{ key: "x/PRODUCTION", limit: 4164, reserved: 4000 }],
      activeRuns: 0,
      pilots: [{ pilotId: "p", status: "ACTIVE", successCount: 5, maxSuccesses: 1, successVideoIds: [] }],
      now,
    });
    assert.deepEqual(codes(r.findings), [
      "BUDGET_OPEN_WHILE_IDLE", "FAILED_TO_GO_LIVE", "PILOT_CAP_EXCEEDED",
      "RUN_FAILED", "STALE_RESERVATION", "UNRESOLVED_UPLOAD_INTENT",
    ]);
    assert.equal(r.healthy, false);
  });
});
