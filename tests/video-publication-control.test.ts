import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { zonedParts } from "@yt-pipeline/pipeline-core";
import {
  POLICIES, parseZoned, validateSlot, upcomingSlots, selectedMode, argValue,
  evaluateEligibility, doCheck, doSchedule, doVerify,
} from "../scripts/video-publication-control";
import type { PubDeps, VideoRow, YouTubeStatus, QaRow } from "../scripts/video-publication-control";

/**
 * The post-review publication transition: PRIVATE + UNSCHEDULED → APPROVED →
 * SCHEDULED FOR A FUTURE GO-LIVE.
 *
 * The whole risk here is a mutation on the wrong asset, at the wrong moment, or
 * one that quietly publishes now instead of later. So the tests assert exactly
 * what is sent to YouTube, what is not sent, and what happens when each half of
 * the two-system write fails.
 *
 * Every YouTube call, database read/write and clock read is injected. Nothing
 * here reaches a real API or mutates production.
 */

const CONTROL = readFileSync("scripts/video-publication-control.ts", "utf8");
const AI = POLICIES["ai-doom-scroll"];
const WC = POLICIES["wet-circuit"];
const TZ = "America/New_York";

const NOW = new Date("2026-08-08T16:00:00Z");        // Sat 12:00 ET
const MON_1500 = "2026-08-10 15:00";                  // Mon 15:00 EDT
const SHA = "a".repeat(64);

const goodQa = (over: Partial<QaRow> = {}): QaRow => ({
  id: "qa-1", overall: "PASS", createdAt: new Date("2026-08-08T10:00:00Z"),
  checks: [{ name: "final_video_sha256", passed: true, severity: "FATAL", detail: "b", value: SHA }],
  ...over,
});

const goodRow = (over: Partial<VideoRow> = {}): VideoRow => ({
  id: "row-1", youtubeId: "yt-abc123", status: "UPLOADED", scheduledAt: null,
  videoPath: "/tmp/final.mp4", ...over,
});

const privateStatus = (over: Partial<YouTubeStatus> = {}): YouTubeStatus => ({
  privacyStatus: "private", publishAt: null,
  rest: { selfDeclaredMadeForKids: false, license: "youtube", embeddable: true },
  ...over,
});

interface FakeOpts {
  row?: VideoRow | null;
  successVideoIds?: string[];
  pilotChannel?: string;
  qa?: QaRow[];
  unresolved?: number;
  future?: { id: string; scheduledAt: Date }[];
  yt?: YouTubeStatus | null;
  ytAfter?: YouTubeStatus | null;
  sha?: string | null;
  ytSetThrows?: boolean;
  dbRows?: number;
  dbThrows?: boolean;
  now?: Date;
}

interface Fake { deps: PubDeps; updates: { id: string; status: Record<string, unknown> }[]; dbWrites: string[]; models: string[] }

function makeFake(policy = AI, o: FakeOpts = {}): Fake {
  const updates: { id: string; status: Record<string, unknown> }[] = [];
  const dbWrites: string[] = [];
  const models: string[] = [];
  // Stateful, so a read-back after a write observes what was written — which is
  // the only way the read-back verification is meaningfully exercised.
  let current: YouTubeStatus | null = o.yt === undefined ? privateStatus() : o.yt;
  const deps: PubDeps = {
    async readRow(model, id) { models.push(model); return o.row === undefined ? goodRow({ id }) : o.row; },
    async readPilot() {
      return { successVideoIds: o.successVideoIds ?? ["row-1"], channel: o.pilotChannel ?? policy.key };
    },
    async readQa() { return o.qa ?? [goodQa()]; },
    async unresolvedIntentCount() { return o.unresolved ?? 0; },
    async futureScheduled(model) { models.push(model); return o.future ?? []; },
    async ytGetStatus() { return current; },
    async ytSetStatus(id, status) {
      if (o.ytSetThrows) throw new Error("quota exceeded");
      updates.push({ id, status });
      // What YouTube reports afterwards: the override wins if the test supplied
      // one (to model a divergent read-back), otherwise the written value.
      current = o.ytAfter !== undefined ? o.ytAfter : {
        privacyStatus: status.privacyStatus as string, publishAt: status.publishAt as string, rest: {},
      };
    },
    async setScheduledAt(model, id) {
      models.push(model);
      if (o.dbThrows) throw new Error("db write failed");
      dbWrites.push(id);
      return o.dbRows ?? 1;
    },
    async fileSha256() { return o.sha === undefined ? SHA : o.sha; },
    now: () => o.now ?? NOW,
    log: () => {},
  };
  return { deps, updates, dbWrites, models };
}

// ── ELIGIBILITY ──────────────────────────────────────────────────────────

describe("eligibility refuses anything not provably ours", () => {
  test("1. an arbitrary YouTube id has no durable row and is refused", async () => {
    const f = makeFake(AI, { row: null });
    const e = await evaluateEligibility(f.deps, AI, "not-ours");
    assert.equal(e.phase, "PROVENANCE_INVALID");
  });

  test("1b. a real row that is NOT a pilot success is refused", async () => {
    const f = makeFake(AI, { successVideoIds: ["some-other-row"] });
    const e = await evaluateEligibility(f.deps, AI, "row-1");
    assert.equal(e.phase, "PROVENANCE_INVALID");
  });

  test("2. a pilot belonging to another channel is refused", async () => {
    const f = makeFake(AI, { pilotChannel: "wet-circuit" });
    const e = await evaluateEligibility(f.deps, AI, "row-1");
    assert.equal(e.phase, "PROVENANCE_INVALID");
  });

  test("3. no pilot-success provenance refused", async () => {
    const f = makeFake(AI, { successVideoIds: [] });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "PROVENANCE_INVALID");
  });

  test("4. missing final QA refused", async () => {
    const f = makeFake(AI, { qa: [] });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "QA_INVALID");
  });

  test("4b. a non-PASS QA verdict refused", async () => {
    const f = makeFake(AI, { qa: [goodQa({ overall: "FAIL" })] });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "QA_INVALID");
  });

  test("5. QA bound to a stale artifact refused", async () => {
    const f = makeFake(AI, { sha: "b".repeat(64) }); // file changed since QA
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "QA_INVALID");
  });

  test("5b. a newer non-PASS record supersedes an older PASS", async () => {
    const f = makeFake(AI, { qa: [
      goodQa({ id: "qa-old", createdAt: new Date("2026-08-08T09:00:00Z") }),
      goodQa({ id: "qa-new", overall: "FAIL", createdAt: new Date("2026-08-08T11:00:00Z") }),
    ] });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "QA_INVALID");
  });

  test("6. an unresolved upload intent refused", async () => {
    const f = makeFake(AI, { unresolved: 1 });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "RECONCILIATION_REQUIRED");
  });

  test("7. a missing youtubeId refused", async () => {
    const f = makeFake(AI, { row: goodRow({ youtubeId: null }) });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "CONFIG_INVALID");
  });

  test("8. an already scheduled video refused (durable or YouTube)", async () => {
    const a = makeFake(AI, { row: goodRow({ scheduledAt: new Date("2026-08-10T19:00:00Z") }) });
    assert.equal((await evaluateEligibility(a.deps, AI, "row-1")).phase, "ALREADY_SCHEDULED");
    const b = makeFake(AI, { yt: privateStatus({ publishAt: "2026-08-10T19:00:00Z" }) });
    assert.equal((await evaluateEligibility(b.deps, AI, "row-1")).phase, "ALREADY_SCHEDULED");
  });

  test("9. an already public video refused", async () => {
    const f = makeFake(AI, { yt: privateStatus({ privacyStatus: "public" }) });
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "ALREADY_PUBLIC");
  });

  test("a clean private pilot success is ELIGIBLE_FOR_SCHEDULING", async () => {
    const f = makeFake();
    assert.equal((await evaluateEligibility(f.deps, AI, "row-1")).phase, "ELIGIBLE_FOR_SCHEDULING");
  });

  test("a missing local artifact still requires a PASS with a binding", async () => {
    const ok = makeFake(AI, { sha: null });
    assert.equal((await evaluateEligibility(ok.deps, AI, "row-1")).phase, "ELIGIBLE_FOR_SCHEDULING");
    const bad = makeFake(AI, { sha: null, qa: [goodQa({ checks: [] })] });
    assert.equal((await evaluateEligibility(bad.deps, AI, "row-1")).phase, "QA_INVALID");
  });
});

// ── HUMAN APPROVAL ───────────────────────────────────────────────────────

describe("human approval", () => {
  test("10. --schedule without the acknowledgement writes nothing", async () => {
    const f = makeFake();
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, false);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.updates.length, 0);
    assert.equal(f.dbWrites.length, 0);
  });

  test("11. acknowledgement does not bypass eligibility", async () => {
    const f = makeFake(AI, { successVideoIds: [] });
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "REFUSED");
    assert.match(r.reason, /PROVENANCE_INVALID/);
    assert.equal(f.updates.length, 0);
  });

  test("a slot is never chosen automatically", async () => {
    const f = makeFake();
    const r = await doSchedule(f.deps, AI, "row-1", null, true);
    assert.equal(r.outcome, "REFUSED");
    assert.match(r.reason, /--publish-at is required/);
  });

  test("an exact row id is always required", async () => {
    const f = makeFake();
    assert.equal((await doSchedule(f.deps, AI, "", MON_1500, true)).outcome, "REFUSED");
  });

  test("CHECK never asserts approval and never writes", async () => {
    const f = makeFake();
    await doCheck(f.deps, AI, "row-1", MON_1500);
    assert.equal(f.updates.length, 0);
    assert.equal(f.dbWrites.length, 0);
    assert.match(CONTROL, /human approval      : NOT YET ASSERTED/);
  });
});

// ── TIME / CADENCE ───────────────────────────────────────────────────────

describe("slot validation", () => {
  const slot = (local: string, occupied: Date[] = [], now = NOW) => {
    const d = parseZoned(local, TZ)!;
    return validateSlot(d, now, AI, occupied);
  };

  test("12/13/14. Monday, Wednesday and Friday are allowed", () => {
    for (const d of ["2026-08-10 15:00", "2026-08-12 15:00", "2026-08-14 15:00"]) {
      assert.equal(slot(d).ok, true, d);
    }
  });

  test("15/16. Tuesday and Thursday refused", () => {
    for (const d of ["2026-08-11 15:00", "2026-08-13 15:00"]) {
      assert.equal(slot(d).code, "SLOT_WRONG_DAY", d);
    }
  });

  test("Saturday and Sunday refused", () => {
    assert.equal(slot("2026-08-15 15:00").code, "SLOT_WRONG_DAY");
    assert.equal(slot("2026-08-16 15:00").code, "SLOT_WRONG_DAY");
  });

  test("17. a past time refused", () => {
    assert.equal(slot("2026-08-03 15:00").code, "SLOT_NOT_FUTURE");
  });

  test("18. the current instant refused — never an accidental immediate publish", () => {
    const d = parseZoned("2026-08-10 15:00", TZ)!;
    assert.equal(validateSlot(d, d, AI, []).code, "SLOT_NOT_FUTURE");
    assert.equal(validateSlot(d, new Date(d.getTime() + 1), AI, []).code, "SLOT_NOT_FUTURE");
  });

  test("19. DST conversion is correct in both directions", () => {
    // EDT (UTC-4): 15:00 local == 19:00 UTC
    assert.equal(parseZoned("2026-08-10 15:00", TZ)!.toISOString(), "2026-08-10T19:00:00.000Z");
    // EST (UTC-5): 15:00 local == 20:00 UTC
    assert.equal(parseZoned("2026-01-05 15:00", TZ)!.toISOString(), "2026-01-05T20:00:00.000Z");
    // Both read back as 15:00 local.
    for (const iso of ["2026-08-10T19:00:00.000Z", "2026-01-05T20:00:00.000Z"]) {
      assert.equal(zonedParts(new Date(iso), TZ).hour, 15);
    }
  });

  test("20. the host timezone cannot change the result", () => {
    const before = process.env.TZ;
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      assert.equal(parseZoned("2026-08-10 15:00", TZ)!.toISOString(), "2026-08-10T19:00:00.000Z", tz);
      assert.equal(slot("2026-08-10 15:00").ok, true, tz);
      assert.equal(slot("2026-08-11 15:00").ok, false, tz);
    }
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  });

  test("21. an occupied slot refused", () => {
    const taken = parseZoned("2026-08-10 15:00", TZ)!;
    assert.equal(slot("2026-08-10 15:00", [taken]).code, "SLOT_OCCUPIED");
    // A different hour the same day is still free.
    assert.equal(slot("2026-08-10 16:00", [taken]).ok, true);
  });

  test("hours outside the historical range refused", () => {
    assert.equal(slot("2026-08-10 09:00").code, "SLOT_OUTSIDE_HOURS");
    assert.equal(slot("2026-08-10 20:00").code, "SLOT_OUTSIDE_HOURS");
    assert.equal(slot("2026-08-10 10:00").ok, true);
    assert.equal(slot("2026-08-10 19:00").ok, true);
  });

  test("an unparseable time is refused, not coerced", () => {
    assert.equal(parseZoned("next monday", TZ), null);
    assert.equal(parseZoned("2026-08-10", TZ), null);
  });

  test("upcoming slots skip occupied dates and non-publication days", () => {
    const taken = [parseZoned("2026-08-10 15:00", TZ)!];
    const s = upcomingSlots(NOW, AI, taken, 6);
    assert.equal(s.length, 6);
    assert.ok(!s.some((x) => x.date === "2026-08-10"), "occupied date skipped");
    for (const x of s) {
      const wd = zonedParts(parseZoned(`${x.date} 15:00`, TZ)!, TZ).weekday;
      assert.ok([1, 3, 5].includes(wd), `${x.date} must be Mon/Wed/Fri`);
    }
  });
});

// ── YOUTUBE WRITE ────────────────────────────────────────────────────────

describe("the YouTube mutation", () => {
  test("22/23. exactly one update, on the intended id, with the exact publishAt", async () => {
    const f = makeFake();
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "SCHEDULED");
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].id, "yt-abc123");
    assert.equal(f.updates[0].status.publishAt, "2026-08-10T19:00:00.000Z");
  });

  test("24. no snippet field is ever sent — title/description/tags untouched", async () => {
    const f = makeFake();
    await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    const sent = f.updates[0].status;
    for (const k of ["title", "description", "tags", "categoryId", "snippet", "thumbnail"]) {
      assert.ok(!(k in sent), `${k} must not be sent`);
    }
    // And the call itself is scoped to the status part only.
    assert.match(CONTROL, /part: \["status"\]/);
    assert.ok(!/videos\.update[\s\S]{0,200}"snippet"/.test(CONTROL));
  });

  test("24b. unrelated status fields are preserved, not reset to defaults", async () => {
    const f = makeFake();
    await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    const sent = f.updates[0].status;
    assert.equal(sent.selfDeclaredMadeForKids, false);
    assert.equal(sent.license, "youtube");
    assert.equal(sent.embeddable, true);
  });

  test("25. privacy stays private — never an immediate public transition", async () => {
    const f = makeFake();
    await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(f.updates[0].status.privacyStatus, "private");
    assert.notEqual(f.updates[0].status.privacyStatus, "public");
  });

  test("the state is re-asserted immediately before writing", async () => {
    // Video went public between CHECK and the write.
    const f = makeFake(AI, { yt: privateStatus(), ytAfter: null });
    const g = makeFake();
    g.deps.ytGetStatus = async () => privateStatus({ privacyStatus: "unlisted" });
    const r = await doSchedule(g.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(g.updates.length, 0);
    void f;
  });

  test("it refuses to silently repair a video that already has publishAt", async () => {
    const f = makeFake();
    let n = 0;
    f.deps.ytGetStatus = async () => {
      n++;
      return n <= 1 ? privateStatus() : privateStatus({ publishAt: "2026-09-01T19:00:00.000Z" });
    };
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.updates.length, 0);
  });

  test("26/27. a read-back mismatch surfaces failure and skips the DB write", async () => {
    const f = makeFake(AI, { ytAfter: privateStatus({ publishAt: "2026-09-09T19:00:00.000Z" }) });
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "READBACK_MISMATCH");
    assert.equal(r.ytWritten, true);
    assert.equal(r.dbWritten, false);
    assert.equal(f.dbWrites.length, 0);
  });

  test("a YouTube write failure reports and writes no DB row", async () => {
    const f = makeFake(AI, { ytSetThrows: true });
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "YOUTUBE_WRITE_FAILED");
    assert.equal(r.ytWritten, false);
    assert.equal(f.dbWrites.length, 0);
  });
});

// ── RECONCILIATION ───────────────────────────────────────────────────────

describe("crash and retry safety", () => {
  test("28. YouTube success + DB success → SCHEDULED", async () => {
    const f = makeFake();
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "SCHEDULED");
    assert.deepEqual([r.ytWritten, r.dbWritten], [true, true]);
  });

  test("29. YouTube success + DB failure → RECONCILIATION_REQUIRED", async () => {
    for (const o of [{ dbThrows: true }, { dbRows: 0 }]) {
      const f = makeFake(AI, o);
      const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
      assert.equal(r.outcome, "RECONCILIATION_REQUIRED");
      assert.equal(r.ytWritten, true);
      assert.equal(r.dbWritten, false);
    }
  });

  test("29b. a blind retry after that cannot double-schedule", async () => {
    // YouTube now carries publishAt; the DB is still null. Pre-flight reads
    // YouTube first and lands in ALREADY_SCHEDULED.
    const f = makeFake(AI, { yt: privateStatus({ publishAt: "2026-08-10T19:00:00.000Z" }) });
    const e = await evaluateEligibility(f.deps, AI, "row-1");
    assert.equal(e.phase, "ALREADY_SCHEDULED");
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.updates.length, 0, "no second YouTube write");
  });

  test("30. an uncertain YouTube result is read, never blindly re-written", async () => {
    // YouTube unreadable → refuse rather than assume and retry.
    const f = makeFake(AI, { yt: null });
    const r = await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(f.updates.length, 0);
  });

  test("31. VERIFY reports divergence read-only", async () => {
    const agreed = makeFake(AI, {
      row: goodRow({ scheduledAt: new Date("2026-08-10T19:00:00.000Z") }),
      yt: privateStatus({ publishAt: "2026-08-10T19:00:00.000Z" }),
    });
    const a = await doVerify(agreed.deps, AI, "row-1");
    assert.equal(a.agreed, true);

    const diverged = makeFake(AI, { yt: privateStatus({ publishAt: "2026-08-10T19:00:00.000Z" }) });
    const d = await doVerify(diverged.deps, AI, "row-1");
    assert.equal(d.agreed, false);
    assert.equal(d.ytPublishAt, "2026-08-10T19:00:00.000Z");
    assert.equal(d.dbScheduledAt, null);
    assert.equal(diverged.updates.length, 0, "VERIFY is read-only");
    assert.equal(diverged.dbWrites.length, 0);
  });

  test("YouTube is written before the durable row", async () => {
    const order: string[] = [];
    const f = makeFake();
    const origSet = f.deps.ytSetStatus;
    f.deps.ytSetStatus = async (id, s) => { order.push("youtube"); return origSet(id, s); };
    const origDb = f.deps.setScheduledAt;
    f.deps.setScheduledAt = async (m, i, a) => { order.push("db"); return origDb(m, i, a); };
    await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    assert.deepEqual(order, ["youtube", "db"]);
  });
});

// ── CHANNEL ISOLATION ────────────────────────────────────────────────────

describe("channel isolation", () => {
  test("32. AI Doom scheduling only ever touches the Video model", async () => {
    const f = makeFake(AI);
    await doSchedule(f.deps, AI, "row-1", MON_1500, true);
    // Collected as a Set so `every` cannot narrow the array's type here.
    const touched = new Set<string>(f.models);
    assert.deepEqual([...touched], ["video"], `saw ${JSON.stringify(f.models)}`);
    assert.ok(!touched.has("wcVideo"));
  });

  test("33. WC scheduling only ever touches the wcVideo model", async () => {
    const f = makeFake(WC, { pilotChannel: "wet-circuit" });
    await doSchedule(f.deps, WC, "row-1", MON_1500, true);
    const touched = new Set<string>(f.models);
    assert.deepEqual([...touched], ["wcVideo"], `saw ${JSON.stringify(f.models)}`);
    assert.ok(!touched.has("video"));
  });

  test("each channel resolves its own pilot", () => {
    assert.equal(AI.pilotId, "ai-doom-private-pilot-1");
    assert.equal(WC.pilotId, "wet-circuit-private-canary-1");
    assert.equal(AI.model, "video");
    assert.equal(WC.model, "wcVideo");
  });

  test("34. neither runtime imports the operator script", () => {
    for (const f of [
      "src/index.ts", "src/pipeline.ts",
      "packages/wc-pipeline/src/index.ts", "packages/wc-pipeline/src/pipeline.ts",
      "packages/pipeline-core/src/index.ts",
    ]) {
      assert.ok(!readFileSync(f, "utf8").includes("video-publication-control"), f);
    }
  });

  test("35. monitors are never referenced", () => {
    assert.ok(!CONTROL.includes("monitor-ai-doom"));
    assert.ok(!CONTROL.includes("MONITOR_AI_ENABLED"));
  });

  test("importing the module runs nothing", () => {
    assert.match(CONTROL, /const isDirectRun =/);
    assert.match(CONTROL, /if \(isDirectRun\) \{/);
  });

  test("both channels keep the Mon/Wed/Fri cadence unchanged", () => {
    assert.deepEqual(AI.days, [1, 3, 5]);
    assert.deepEqual(WC.days, [1, 3, 5]);
    assert.equal(AI.timezone, "America/New_York");
    assert.equal(WC.timezone, "America/New_York");
  });

  test("mode and argument parsing never guesses", () => {
    assert.equal(selectedMode(["n", "x"]), "CHECK");
    assert.equal(selectedMode(["n", "x", "--schedule"]), "SCHEDULE");
    assert.equal(selectedMode(["n", "x", "--schedule", "--verify"]), "AMBIGUOUS");
    assert.equal(argValue(["n", "x", "--video", "row-9"], "--video"), "row-9");
    assert.equal(argValue(["n", "x"], "--video"), null);
  });
});
