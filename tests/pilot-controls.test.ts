import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  uploadPolicyFor, assertPilotUploadAllowed, assertRunnable, PilotBlockedError,
} from "../packages/pipeline-core/src/lib/pilot";
import type { PilotConfig } from "../packages/pipeline-core/src/lib/pilot";
import {
  nextWindowStart, isInWindow, isWindowDay, isDst, offsetMinutes, zonedTimeToUtc,
  formatZoned, EASTERN,
} from "../packages/pipeline-core/src/lib/easternWindow";

/**
 * The controls a bounded private pilot needs, pinned.
 *
 * The real production path could not enforce any of these. It scheduled a
 * publish time for every upload (private + publishAt is how you tell YouTube
 * to go public later), counted successful videos nowhere, uploaded without a
 * durable intent, always built a Short, bought narration before checking the
 * topic could be illustrated, and computed "2 PM Eastern" as a fixed 19:00
 * UTC — which is 3 PM in summer.
 */

const PILOT: PilotConfig = {
  id: "p1", pilotId: "ai-doom-private-pilot-1",
  channel: "ai-doom-scroll", channelId: "UCSbJfiA1aobp6G_rgwbHPMw",
  status: "ACTIVE", maxSuccesses: 3, successCount: 0, successVideoIds: [],
  activatedAt: new Date("2026-08-04T00:00:00Z"), completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20, timezone: EASTERN,
};
const SLOT = new Date("2026-08-05T21:00:00Z");

describe("pilot uploads can never carry a publish time", () => {
  test("a pilot policy drops the scheduled slot", () => {
    const p = uploadPolicyFor(PILOT, SLOT);
    assert.equal(p.source, "pilot");
    assert.equal(p.privacyStatus, "private");
    assert.equal(p.scheduledSlot, null, "a pilot must never carry a publish time");
  });

  test("ordinary production keeps its scheduled slot", () => {
    const p = uploadPolicyFor(null, SLOT);
    assert.equal(p.source, "normal");
    assert.equal(p.scheduledSlot, SLOT, "the pilot restriction must not redefine all production");
    assert.equal(p.shortsEnabled, true);
  });

  test("a pilot that declares non-private or permits publishing is refused", () => {
    assert.throws(() => uploadPolicyFor({ ...PILOT, privacyStatus: "public" }, null),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_NOT_PRIVATE");
    assert.throws(() => uploadPolicyFor({ ...PILOT, allowPublishAt: true }, null),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_ALLOWS_PUBLISH");
  });

  test("a publishAt reintroduced later fails closed", () => {
    const p = uploadPolicyFor(PILOT, SLOT);
    assert.throws(() => assertPilotUploadAllowed(p, new Date()),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_PUBLISH_AT_SET");
    assert.doesNotThrow(() => assertPilotUploadAllowed(p, null));
  });

  test("a slot smuggled back into the policy fails closed", () => {
    const tampered = { ...uploadPolicyFor(PILOT, SLOT), scheduledSlot: SLOT };
    assert.throws(() => assertPilotUploadAllowed(tampered, null),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_SLOT_PRESENT");
  });

  test("non-pilot policy is not subject to the pilot assertion", () => {
    assert.doesNotThrow(() => assertPilotUploadAllowed(uploadPolicyFor(null, SLOT), SLOT));
  });
});

describe("pilot runnability", () => {
  test("PREPARED does not run", () => {
    assert.throws(() => assertRunnable({ ...PILOT, status: "PREPARED" }),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_NOT_ACTIVE");
  });
  for (const status of ["PAUSED", "COMPLETED", "FAILED"] as const) {
    test(`${status} does not run`, () => {
      assert.throws(() => assertRunnable({ ...PILOT, status }), PilotBlockedError);
    });
  }
  test("ACTIVE with slots left runs", () => {
    assert.doesNotThrow(() => assertRunnable(PILOT));
  });
  test("boundary: 0, 1, 2 used may run; 3 may not", () => {
    for (const used of [0, 1, 2]) {
      assert.doesNotThrow(() => assertRunnable({ ...PILOT, successCount: used }), `${used} used`);
    }
    assert.throws(() => assertRunnable({ ...PILOT, successCount: 3 }),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_CAP_REACHED");
    assert.throws(() => assertRunnable({ ...PILOT, successCount: 4 }), PilotBlockedError);
  });
  test("an activated-at is required", () => {
    assert.throws(() => assertRunnable({ ...PILOT, activatedAt: null }), PilotBlockedError);
  });
});

describe("the cap is claimed atomically in SQL, not in memory", () => {
  const src = readFileSync("packages/pipeline-core/src/lib/pilot.ts", "utf8");

  test("the limit is inside the UPDATE, so two processes cannot both win", () => {
    assert.match(src, /UPDATE "production_pilot"[\s\S]*?"successCount" = "successCount" \+ 1/);
    assert.match(src, /AND "successCount" < "maxSuccesses"/);
    assert.match(src, /if \(affected !== 1\)/);
  });

  test("a claim is released when the upload does not complete", () => {
    assert.match(src, /export async function releasePilotSlot/);
    assert.match(src, /GREATEST\("successCount" - 1/);
  });

  test("a release can never erase a confirmed upload", () => {
    assert.match(src, /COALESCE\(array_length\("successVideoIds", 1\), 0\)\)/);
  });

  test("confirming an upload records it WITHOUT completing the pilot", () => {
    // It used to mark COMPLETED once successVideoIds reached maxSuccesses,
    // conflating the current authorisation ceiling with human acceptance. For a
    // progressively authorised pilot (0/1 → review → 1/2 → review → 2/3) that
    // made the pilot non-ACTIVE at 1/1, so the next video was unreachable.
    const confirm = src.slice(
      src.indexOf("export async function confirmPilotSlot"),
      src.indexOf("export async function completePilot"),
    );
    assert.match(confirm, /array_append\("successVideoIds", \$2\)/);
    assert.ok(!confirm.includes("'COMPLETED'"), "must not complete the pilot");
    assert.ok(!confirm.includes("completedAt"), "must not write completedAt");
  });

  test("completion is a separate guarded compare-and-set", () => {
    const complete = src.slice(src.indexOf("export async function completePilot"));
    assert.match(complete, /SET "status" = 'COMPLETED', "completedAt" = NOW\(\)/);
    assert.match(complete, /AND "status" = 'ACTIVE'/);
    assert.match(complete, /AND "successCount" = \$2/);
    assert.match(complete, /AND "maxSuccesses" = \$2/);
  });

  test("a consumed ceiling still blocks the next claim", () => {
    assert.match(src, /AND "successCount" < "maxSuccesses"/);
  });

  test("only an ACTIVE pilot can have a slot claimed", () => {
    assert.match(src, /AND "status" = 'ACTIVE'/);
  });
});

describe("the real production path is wired for the pilot", () => {
  const pipeline = readFileSync("src/pipeline.ts", "utf8");
  const upload = readFileSync("packages/pipeline-core/src/stages/youtubeUpload.ts", "utf8");

  test("the cap is checked before a candidate is created", () => {
    assert.match(pipeline, /assertRunnable\(pilot\)/);
    assert.match(pipeline, /remainingSlots\(pilot\.pilotId\)/);
    assert.match(pipeline, /refusing to create a candidate/);
  });

  test("an unresolved upload intent blocks another pilot run", () => {
    assert.match(pipeline, /UNRESOLVED_INTENT/);
    assert.match(pipeline, /reconcile before another pilot run/);
  });

  test("Shorts are skipped during a pilot, by config not by deletion", () => {
    assert.match(pipeline, /skipDuringPilot: true/);
    assert.match(pipeline, /STAGES\.filter\(\(s\) => !\(pilot && s\.skipDuringPilot\)\)/);
    assert.match(pipeline, /shortsGenerator/, "the stage must still exist for normal production");
  });

  test("feasibility runs before voiceover", () => {
    const feas = pipeline.indexOf('name: "visualFeasibilityGate"');
    const voice = pipeline.indexOf('name: "voiceover"');
    assert.ok(feas > 0 && voice > 0 && feas < voice, "the gate must precede any spend");
  });

  test("pilot uploads go through guardedUpload, not the raw insert", () => {
    const guarded = upload.indexOf("guardedUpload(");
    const raw = upload.indexOf("youtube.videos.insert(");
    assert.ok(guarded > 0 && raw > 0 && guarded < raw,
      "the guarded path must be reached before the direct insert");
    assert.match(upload, /policy\.source === "pilot" && policy\.requireGuardedUpload/);
  });

  test("a failed pilot upload releases its slot", () => {
    assert.match(upload, /await releasePilotSlot\(pilot!\.pilotId\)/);
  });

  test("resume targets are named, not indexed", () => {
    assert.match(pipeline, /RESUME_FROM: Partial<Record<VideoStatus, string>>/);
    assert.doesNotMatch(pipeline, /RESUME_FROM\[stuckVideo\.status\]!;\s*\n\s*const resumeStages = STAGES\.slice/);
  });
});

describe("Eastern window is timezone-aware, not a fixed offset", () => {
  test("EDT and EST offsets are read from the zone", () => {
    assert.equal(offsetMinutes(new Date("2026-08-04T12:00:00Z")), -240, "EDT is UTC-4");
    assert.equal(offsetMinutes(new Date("2026-12-01T12:00:00Z")), -300, "EST is UTC-5");
  });

  test("DST is detected, not assumed", () => {
    assert.equal(isDst(new Date("2026-08-04T12:00:00Z")), true);
    assert.equal(isDst(new Date("2026-12-01T12:00:00Z")), false);
  });

  test("5 PM local is a different UTC instant in summer and winter", () => {
    const summer = zonedTimeToUtc(2026, 8, 5, 17);
    const winter = zonedTimeToUtc(2026, 12, 2, 17);
    assert.equal(summer.toISOString(), "2026-08-05T21:00:00.000Z");
    assert.equal(winter.toISOString(), "2026-12-02T22:00:00.000Z");
    assert.notEqual(summer.getUTCHours(), winter.getUTCHours(),
      "a fixed UTC hour cannot express a local-time rule");
  });

  test("windows fall on Monday, Wednesday and Friday only", () => {
    for (const d of ["2026-08-03", "2026-08-05", "2026-08-07"]) {
      assert.equal(isWindowDay(new Date(`${d}T21:00:00Z`)), true, d);
    }
    for (const d of ["2026-08-04", "2026-08-06", "2026-08-08", "2026-08-09"]) {
      assert.equal(isWindowDay(new Date(`${d}T21:00:00Z`)), false, d);
    }
  });

  test("the window is 5-8 PM local, exclusive of 8", () => {
    assert.equal(isInWindow(zonedTimeToUtc(2026, 8, 5, 16, 59)), false);
    assert.equal(isInWindow(zonedTimeToUtc(2026, 8, 5, 17, 0)), true);
    assert.equal(isInWindow(zonedTimeToUtc(2026, 8, 5, 19, 59)), true);
    assert.equal(isInWindow(zonedTimeToUtc(2026, 8, 5, 20, 0)), false);
  });

  test("the next window after 2026-08-04 is Wednesday the 5th at 5 PM EDT", () => {
    const n = nextWindowStart(new Date("2026-08-04T12:00:00Z"));
    assert.equal(n.toISOString(), "2026-08-05T21:00:00.000Z");
    assert.match(formatZoned(n), /Wednesday, August 5, 2026 at 5:00 PM EDT/);
  });

  test("across the November DST transition the local hour holds", () => {
    // DST ends 2026-11-01. The first window after it must still be 5 PM local.
    const n = nextWindowStart(new Date("2026-11-01T12:00:00Z"));
    assert.match(formatZoned(n), /5:00 PM EST/);
    assert.equal(isInWindow(n), true);
  });

  test("execution time and YouTube publishAt stay separate", () => {
    // The window says when the pipeline may RUN. A pilot publishes nothing.
    const policy = uploadPolicyFor(PILOT, nextWindowStart(new Date("2026-08-04T12:00:00Z")));
    assert.equal(policy.scheduledSlot, null);
  });
});
