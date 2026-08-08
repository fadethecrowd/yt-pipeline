import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  nextPublishSlot, describeSlot, zonedParts, uploadPolicyFor,
  PUBLISH_DAYS, PUBLISH_HOUR_LOCAL, PUBLISH_TIMEZONE,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";

/**
 * Ordinary-production publication slots.
 *
 * The old selector used a fixed 19:00 UTC hour and a UTC weekday to express a
 * policy stated as "Mon/Wed/Fri at 3 PM Eastern". Both are wrong: a fixed UTC
 * hour is a moving local hour across DST, and a UTC weekday is not an Eastern
 * weekday. It also had no collision handling, so every video made on one day
 * got the identical slot.
 */

const TZ = "America/New_York";
const AI_UPLOAD = readFileSync("packages/pipeline-core/src/stages/youtubeUpload.ts", "utf8");
const WC_UPLOAD = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");

const local = (d: Date) => zonedParts(d, TZ);
/** Saturday 2026-08-08 12:00 ET — the "now" most cases start from. */
const SAT = new Date("2026-08-08T16:00:00Z");

describe("policy constants are grounded, not invented", () => {
  test("Mon/Wed/Fri at 15:00 America/New_York", () => {
    assert.deepEqual(PUBLISH_DAYS, [1, 3, 5]);
    assert.equal(PUBLISH_HOUR_LOCAL, 15);
    assert.equal(PUBLISH_TIMEZONE, "America/New_York");
  });
});

describe("local wall clock and local weekday", () => {
  test("1/3. summer Monday resolves to 15:00 EDT == 19:00Z", () => {
    const s = nextPublishSlot(SAT);
    assert.equal(s.toISOString(), "2026-08-10T19:00:00.000Z");
    assert.equal(local(s).hour, 15);
    assert.equal(local(s).weekday, 1);
  });

  test("2/4. winter Monday resolves to 15:00 EST == 20:00Z", () => {
    // Sat 2026-01-03 12:00 ET → next publication day is Mon 2026-01-05.
    const s = nextPublishSlot(new Date("2026-01-03T17:00:00Z"));
    assert.equal(s.toISOString(), "2026-01-05T20:00:00.000Z");
    assert.equal(local(s).hour, 15);
    assert.equal(local(s).weekday, 1);
  });

  test("the same local hour maps to different UTC hours across the year", () => {
    const summer = nextPublishSlot(SAT);
    const winter = nextPublishSlot(new Date("2026-01-03T17:00:00Z"));
    assert.notEqual(summer.getUTCHours(), winter.getUTCHours());
    assert.equal(local(summer).hour, local(winter).hour);
  });

  test("5. Wednesday is selected when it is next", () => {
    // Mon 2026-08-10 16:00 ET — Monday's slot has passed.
    const s = nextPublishSlot(new Date("2026-08-10T20:00:00Z"));
    assert.equal(local(s).weekday, 3);
    assert.equal(s.toISOString(), "2026-08-12T19:00:00.000Z");
  });

  test("6. Friday is selected when it is next", () => {
    const s = nextPublishSlot(new Date("2026-08-12T20:00:00Z")); // Wed after the slot
    assert.equal(local(s).weekday, 5);
    assert.equal(s.toISOString(), "2026-08-14T19:00:00.000Z");
  });

  test("7/8/9. Tue, Thu, Sat and Sun are never selected", () => {
    for (const from of [
      "2026-08-11T13:00:00Z", "2026-08-13T13:00:00Z",
      "2026-08-15T13:00:00Z", "2026-08-16T13:00:00Z",
    ]) {
      const wd = local(nextPublishSlot(new Date(from))).weekday;
      assert.ok([1, 3, 5].includes(wd), `${from} → weekday ${wd}`);
    }
  });

  test("a Sunday 20:00 ET instant is not treated as Monday", () => {
    // 2026-08-16 20:00 ET == 2026-08-17T00:00Z, i.e. Monday in UTC. The old
    // getUTCDay() logic would have called this a publication day already.
    const from = new Date("2026-08-17T00:00:00Z");
    assert.equal(local(from).weekday, 0, "still Sunday locally (0 = Sunday)");
    const s = nextPublishSlot(from);
    assert.equal(local(s).weekday, 1);
    assert.equal(s.toISOString(), "2026-08-17T19:00:00.000Z");
  });

  test("same-day is used when the slot has not yet passed", () => {
    const s = nextPublishSlot(new Date("2026-08-10T13:00:00Z")); // Mon 09:00 ET
    assert.equal(s.toISOString(), "2026-08-10T19:00:00.000Z");
  });

  test("the slot is always strictly future", () => {
    const exact = new Date("2026-08-10T19:00:00.000Z");
    assert.ok(nextPublishSlot(exact).getTime() > exact.getTime());
    assert.equal(nextPublishSlot(exact).toISOString(), "2026-08-12T19:00:00.000Z");
  });
});

describe("collision avoidance", () => {
  test("10. an occupied Monday moves to Wednesday", () => {
    const mon = new Date("2026-08-10T19:00:00.000Z");
    assert.equal(nextPublishSlot(SAT, { occupied: [mon] }).toISOString(),
      "2026-08-12T19:00:00.000Z");
  });

  test("11. an occupied Wednesday moves to Friday", () => {
    const occupied = [new Date("2026-08-10T19:00:00.000Z"), new Date("2026-08-12T19:00:00.000Z")];
    assert.equal(nextPublishSlot(SAT, { occupied }).toISOString(), "2026-08-14T19:00:00.000Z");
  });

  test("12. an occupied Friday moves to the following Monday", () => {
    const occupied = [
      new Date("2026-08-10T19:00:00.000Z"), new Date("2026-08-12T19:00:00.000Z"),
      new Date("2026-08-14T19:00:00.000Z"),
    ];
    assert.equal(nextPublishSlot(SAT, { occupied }).toISOString(), "2026-08-17T19:00:00.000Z");
  });

  test("collision is by exact instant, so an unrelated time does not block", () => {
    const other = new Date("2026-08-10T18:00:00.000Z"); // 14:00 ET, not our slot
    assert.equal(nextPublishSlot(SAT, { occupied: [other] }).toISOString(),
      "2026-08-10T19:00:00.000Z");
  });

  test("an exhausted horizon throws rather than returning a colliding slot", () => {
    // Every publication slot inside a 10-day horizon of SAT is taken.
    const occupied = [
      "2026-08-10T19:00:00.000Z", "2026-08-12T19:00:00.000Z",
      "2026-08-14T19:00:00.000Z", "2026-08-17T19:00:00.000Z",
    ].map((s) => new Date(s));
    assert.throws(() => nextPublishSlot(SAT, { occupied, horizonDays: 10 }), /no unoccupied/);
    // With the default horizon it simply moves further out.
    assert.equal(nextPublishSlot(SAT, { occupied }).toISOString(), "2026-08-19T19:00:00.000Z");
  });
});

describe("host timezone independence", () => {
  test("13/14/15. UTC, Los_Angeles and Tokyo all give the same instant", () => {
    const before = process.env.TZ;
    const results: string[] = [];
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      results.push(nextPublishSlot(SAT).toISOString());
      results.push(nextPublishSlot(new Date("2026-01-03T17:00:00Z")).toISOString());
    }
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    assert.equal(new Set(results.filter((_, i) => i % 2 === 0)).size, 1, "summer identical");
    assert.equal(new Set(results.filter((_, i) => i % 2 === 1)).size, 1, "winter identical");
  });
});

describe("16. DST transitions do not move the local publish hour", () => {
  test("spring forward (2026-03-08) — Friday before, Monday after", () => {
    const friBefore = nextPublishSlot(new Date("2026-03-06T13:00:00Z")); // Fri 08:00 EST
    const monAfter = nextPublishSlot(new Date("2026-03-09T13:00:00Z"));  // Mon 09:00 EDT
    assert.equal(local(friBefore).hour, 15);
    assert.equal(local(monAfter).hour, 15);
    assert.equal(friBefore.toISOString(), "2026-03-06T20:00:00.000Z"); // EST
    assert.equal(monAfter.toISOString(), "2026-03-09T19:00:00.000Z");  // EDT
  });

  test("fall back (2026-11-01) — Friday before, Monday after", () => {
    const friBefore = nextPublishSlot(new Date("2026-10-30T13:00:00Z")); // EDT
    const monAfter = nextPublishSlot(new Date("2026-11-02T13:00:00Z"));  // EST
    assert.equal(local(friBefore).hour, 15);
    assert.equal(local(monAfter).hour, 15);
    assert.equal(friBefore.toISOString(), "2026-10-30T19:00:00.000Z");
    assert.equal(monAfter.toISOString(), "2026-11-02T20:00:00.000Z");
  });

  test("every slot for a year reads 15:00 local and lands on Mon/Wed/Fri", () => {
    let cur = new Date("2026-01-01T05:00:00Z");
    for (let i = 0; i < 156; i++) {
      const s = nextPublishSlot(cur);
      const p = local(s);
      assert.equal(p.hour, 15, `slot ${s.toISOString()} is not 15:00 local`);
      assert.equal(p.minute, 0);
      assert.ok([1, 3, 5].includes(p.weekday), `slot ${s.toISOString()} weekday ${p.weekday}`);
      assert.ok(s.getTime() > cur.getTime());
      cur = s;
    }
  });
});

describe("17/18. upload policy is unchanged", () => {
  const pilot: PilotConfig = {
    id: "r", pilotId: "p", channel: "ai-doom-scroll", channelId: "UC",
    status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
    activatedAt: new Date(), completedAt: null,
    privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
    requireFeasibility: true, requireGuardedUpload: true,
    windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
    timezone: TZ,
  };

  test("17. a pilot still gets no publish slot", () => {
    const slot = nextPublishSlot(SAT);
    assert.equal(uploadPolicyFor(pilot, slot).scheduledSlot, null);
    assert.equal(uploadPolicyFor(pilot, slot).privacyStatus, "private");
  });

  test("18. ordinary production still gets the future slot", () => {
    const slot = nextPublishSlot(SAT);
    const p = uploadPolicyFor(null, slot);
    assert.equal(p.scheduledSlot?.toISOString(), slot.toISOString());
    assert.ok(p.scheduledSlot!.getTime() > SAT.getTime());
  });
});

describe("19/20. both channels use the shared selector", () => {
  test("19. AI Doom delegates and is collision-aware", () => {
    assert.match(AI_UPLOAD, /import \{ nextPublishSlot, describeSlot \}/);
    assert.match(AI_UPLOAD, /async function getNextPublishSlot\(\): Promise<Date>/);
    assert.match(AI_UPLOAD, /prisma\.video\.findMany/);
    assert.match(AI_UPLOAD, /await getNextPublishSlot\(\)/);
  });

  test("20. WC delegates and is collision-aware", () => {
    assert.match(WC_UPLOAD, /nextPublishSlot, describeSlot,/);
    assert.match(WC_UPLOAD, /async function getNextPublishSlot\(\): Promise<Date>/);
    assert.match(WC_UPLOAD, /prisma\.wcVideo\.findMany/);
    assert.match(WC_UPLOAD, /await getNextPublishSlot\(\)/);
  });

  test("the fixed-UTC constants are gone from both", () => {
    for (const [name, src] of [["ai-doom", AI_UPLOAD], ["wc", WC_UPLOAD]] as const) {
      assert.ok(!src.includes("PUBLISH_HOUR_UTC"), `${name} still has PUBLISH_HOUR_UTC`);
      assert.ok(!src.includes("getUTCDay()"), `${name} still uses getUTCDay()`);
      assert.ok(!src.includes("setUTCHours"), `${name} still uses setUTCHours`);
    }
  });

  test("each channel reads only its own table for occupied slots", () => {
    assert.ok(!AI_UPLOAD.includes("wcVideo.findMany"));
    assert.ok(!WC_UPLOAD.includes("prisma.video.findMany"));
  });

  test("WC's pre-launch behaviour is preserved", () => {
    assert.match(WC_UPLOAD, /preLaunch \? null : await getNextPublishSlot\(\)/);
  });

  test("describeSlot reports the local reading, for logs", () => {
    const s = new Date("2026-08-10T19:00:00.000Z");
    const d = describeSlot(s);
    assert.match(d, /15:00 local/);
    assert.match(d, /America\/New_York/);
  });
});
