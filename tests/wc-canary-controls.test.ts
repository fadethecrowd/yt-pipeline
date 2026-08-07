import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  uploadPolicyFor, assertPilotUploadAllowed, assertRunnable, PilotBlockedError,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import {
  buildSpokenUnits, spokenCharacterCount, spokenOutlineSegments,
} from "@yt-pipeline/pipeline-core";
import {
  isInWindow, nextWindowStart, formatZoned, zonedParts, isDst,
} from "@yt-pipeline/pipeline-core";
import { wcDurationEnvelope } from "../packages/wc-pipeline/src/stages/visualFeasibilityGate";
import { runtimeRange, CHARS_PER_SECOND, TITLE_CARD_S } from "@yt-pipeline/pipeline-core";

/**
 * Controls required for a bounded, private Wet Circuit canary.
 *
 * These lock the behaviour the WC production path did NOT have before this
 * pass: a durable one-video cap, private-with-no-publishAt uploads, Shorts
 * suppression, a feasibility/duration gate ahead of any spend, a per-candidate
 * budget window, and an execution window that never becomes a publish time.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

const WC_CANARY: PilotConfig = {
  id: "row-1",
  pilotId: "wet-circuit-private-canary-1",
  channel: "wet-circuit",
  channelId: "UC9iJDqlrKEs0uuMeIjb9DVA",
  status: "PREPARED",
  maxSuccesses: 1,
  successCount: 0,
  successVideoIds: [],
  activatedAt: null,
  completedAt: null,
  privacyStatus: "private",
  allowPublishAt: false,
  shortsEnabled: false,
  requireFeasibility: true,
  requireGuardedUpload: true,
  windowDays: [1, 3, 5], // Mon, Wed, Fri
  windowStartHour: 17,
  windowEndHour: 20,
  timezone: "America/New_York",
};

const active = (over: Partial<PilotConfig> = {}): PilotConfig => ({
  ...WC_CANARY, status: "ACTIVE", activatedAt: new Date("2026-08-03T21:00:00Z"), ...over,
});

const WC_WINDOW = {
  days: WC_CANARY.windowDays,
  startHour: WC_CANARY.windowStartHour,
  endHour: WC_CANARY.windowEndHour,
  timeZone: WC_CANARY.timezone,
};

// ── C. Durable one-video cap ──────────────────────────────────────────────

describe("WC canary — durable one-video cap", () => {
  test("a PREPARED canary refuses to run", () => {
    assert.throws(() => assertRunnable(WC_CANARY), (e: unknown) => {
      assert.ok(e instanceof PilotBlockedError);
      assert.equal(e.code, "PILOT_NOT_ACTIVE");
      return true;
    });
  });

  test("an ACTIVE canary with no activation timestamp refuses to run", () => {
    assert.throws(
      () => assertRunnable({ ...WC_CANARY, status: "ACTIVE", activatedAt: null }),
      (e: unknown) => {
        assert.ok(e instanceof PilotBlockedError);
        assert.equal(e.code, "PILOT_NOT_ACTIVATED");
        return true;
      },
    );
  });

  test("1/1 used is refused — the cap is one video, not one attempt", () => {
    assert.throws(() => assertRunnable(active({ successCount: 1 })), (e: unknown) => {
      assert.ok(e instanceof PilotBlockedError);
      assert.equal(e.code, "PILOT_CAP_REACHED");
      return true;
    });
  });

  test("0/1 on an activated canary is runnable", () => {
    assert.doesNotThrow(() => assertRunnable(active()));
  });

  test("the canary is bounded at exactly one success", () => {
    assert.equal(WC_CANARY.maxSuccesses, 1);
  });
});

// ── B. Private-only, no publishAt ─────────────────────────────────────────

describe("WC canary — private with no publishAt", () => {
  test("a normal slot is discarded for a pilot upload", () => {
    const slot = new Date("2026-08-07T19:00:00Z");
    const policy = uploadPolicyFor(active(), slot);
    assert.equal(policy.source, "pilot");
    assert.equal(policy.privacyStatus, "private");
    assert.equal(policy.scheduledSlot, null, "a canary must carry no scheduled slot");
  });

  test("non-pilot WC production keeps its scheduled slot", () => {
    const slot = new Date("2026-08-07T19:00:00Z");
    const policy = uploadPolicyFor(null, slot);
    assert.equal(policy.source, "normal");
    assert.equal(policy.scheduledSlot?.toISOString(), slot.toISOString());
  });

  test("a canary declaring anything but private is refused", () => {
    assert.throws(
      () => uploadPolicyFor(active({ privacyStatus: "unlisted" }), null),
      (e: unknown) => {
        assert.ok(e instanceof PilotBlockedError);
        assert.equal(e.code, "PILOT_NOT_PRIVATE");
        return true;
      },
    );
  });

  test("a canary permitting a publish time is refused", () => {
    assert.throws(
      () => uploadPolicyFor(active({ allowPublishAt: true }), null),
      (e: unknown) => {
        assert.ok(e instanceof PilotBlockedError);
        assert.equal(e.code, "PILOT_ALLOWS_PUBLISH");
        return true;
      },
    );
  });

  test("a publishAt reintroduced after policy construction is refused at the boundary", () => {
    const policy = uploadPolicyFor(active(), null);
    assert.throws(
      () => assertPilotUploadAllowed(policy, new Date("2026-08-07T19:00:00Z")),
      (e: unknown) => {
        assert.ok(e instanceof PilotBlockedError);
        assert.equal(e.code, "PILOT_PUBLISH_AT_SET");
        return true;
      },
    );
  });

  test("a slot smuggled onto the policy object is refused", () => {
    const policy = { ...uploadPolicyFor(active(), null), scheduledSlot: new Date() };
    assert.throws(() => assertPilotUploadAllowed(policy, null), (e: unknown) => {
      assert.ok(e instanceof PilotBlockedError);
      assert.equal(e.code, "PILOT_SLOT_PRESENT");
      return true;
    });
  });

  test("ordinary production is not constrained by the pilot assertion", () => {
    const policy = uploadPolicyFor(null, new Date("2026-08-07T19:00:00Z"));
    assert.doesNotThrow(() => assertPilotUploadAllowed(policy, new Date()));
  });
});

// ── E. Shorts suppression ─────────────────────────────────────────────────

describe("WC canary — Shorts suppression", () => {
  test("the canary declares Shorts disabled", () => {
    assert.equal(WC_CANARY.shortsEnabled, false);
    assert.equal(uploadPolicyFor(active(), null).shortsEnabled, false);
  });

  test("a pilot filter removes exactly the Shorts stage and keeps the rest", () => {
    // Mirrors the filter in packages/wc-pipeline/src/pipeline.ts.
    const STAGES = [
      { name: "topicDiscovery" }, { name: "scriptGenerator" }, { name: "qualityGate" },
      { name: "visualFeasibilityGate" }, { name: "seoGenerator" },
      { name: "wcThumbnailHeadlineGenerator" }, { name: "wcThumbnailGenerator" },
      { name: "voiceover" }, { name: "videoAssembly" }, { name: "youtubeUpload" },
      { name: "shortsGenerator", skipDuringPilot: true }, { name: "notify" },
    ] as { name: string; skipDuringPilot?: boolean }[];

    const pilotStages = STAGES.filter((s) => !s.skipDuringPilot).map((s) => s.name);
    assert.ok(!pilotStages.includes("shortsGenerator"), "Shorts must not run during a canary");
    assert.equal(pilotStages.length, STAGES.length - 1, "exactly one stage is skipped");
    for (const kept of ["voiceover", "videoAssembly", "youtubeUpload", "notify", "visualFeasibilityGate"]) {
      assert.ok(pilotStages.includes(kept), `${kept} must still run`);
    }

    // Normal production keeps it.
    assert.ok(STAGES.filter(() => true).map((s) => s.name).includes("shortsGenerator"));
  });

  test("resume targets survive the Shorts stage being filtered out", () => {
    // Name-based resume: the index must be resolved against the SAME list the
    // run will execute, which differs between pilot and normal runs.
    const RESUME_FROM: Record<string, string> = {
      SEO_DONE: "wcThumbnailHeadlineGenerator",
      VOICEOVER_DONE: "videoAssembly",
      ASSEMBLY_DONE: "youtubeUpload",
      ASSEMBLY_PENDING: "videoAssembly",
      UPLOAD_PENDING: "youtubeUpload",
    };
    const STAGES = [
      "topicDiscovery", "scriptGenerator", "qualityGate", "visualFeasibilityGate",
      "seoGenerator", "wcThumbnailHeadlineGenerator", "wcThumbnailGenerator",
      "voiceover", "videoAssembly", "youtubeUpload", "shortsGenerator", "notify",
    ];
    const pilotStages = STAGES.filter((s) => s !== "shortsGenerator");

    for (const [status, target] of Object.entries(RESUME_FROM)) {
      for (const list of [STAGES, pilotStages]) {
        const idx = list.indexOf(target);
        assert.ok(idx >= 0, `${status} → ${target} must exist in the stage list`);
        assert.equal(list[idx], target, `${status} must resume at ${target}, not a neighbour`);
      }
    }
  });
});

// ── F. Spoken units, coverage, duration envelope ──────────────────────────

describe("WC canary — spoken units and narration coverage", () => {
  const script = {
    hook: "Your fishfinder is lying to you about depth.",
    segments: [
      { segmentIndex: 0, title: "The problem", narration: "Transducer placement changes everything.", visual_prompt: "boat hull", duration_seconds: 60 },
      { segmentIndex: 1, title: "The fix", narration: "Mount it away from turbulence.", visual_prompt: "transducer", duration_seconds: 60 },
    ],
    cta: "Subscribe for more marine electronics.",
    estimatedTotalDuration: 120,
  };

  test("hook and CTA are spoken exactly once", () => {
    const units = buildSpokenUnits(script);
    const whole = units.map((u) => u.text).join("\n");
    const count = (h: string, n: string) => h.split(n).length - 1;
    assert.equal(count(whole, script.hook), 1, "hook must be spoken exactly once");
    assert.equal(count(whole, script.cta), 1, "CTA must be spoken exactly once");
  });

  test("an already-folded hook and CTA are not folded a second time", () => {
    // This is what WC's scriptGenerator actually persists: it space-joins the
    // hook into segments[0] and the CTA into the last segment.
    const folded = {
      ...script,
      segments: [
        { ...script.segments[0], narration: `${script.hook} ${script.segments[0].narration}` },
        { ...script.segments[1], narration: `${script.segments[1].narration} ${script.cta}` },
      ],
    };
    const whole = buildSpokenUnits(folded).map((u) => u.text).join("\n");
    const count = (h: string, n: string) => h.split(n).length - 1;
    assert.equal(count(whole, script.hook), 1, "a pre-folded hook must not be duplicated");
    assert.equal(count(whole, script.cta), 1, "a pre-folded CTA must not be duplicated");
  });

  test("every segment's narration appears in the spoken text", () => {
    const whole = buildSpokenUnits(script).map((u) => u.text).join("\n");
    for (const s of script.segments) {
      assert.ok(whole.includes(s.narration), `segment ${s.segmentIndex} must be narrated`);
    }
  });

  test("one unit per segment — the billed request count does not change", () => {
    assert.equal(buildSpokenUnits(script).length, script.segments.length);
  });

  test("planning sees byte-identical text to what narration submits", () => {
    const units = buildSpokenUnits(script);
    const planned = spokenOutlineSegments(script);
    for (let i = 0; i < units.length; i++) {
      assert.equal(planned[i].narration, units[i].text,
        "the feasibility gate must plan against the exact submitted bytes");
    }
  });

  test("the submitted character count is the sum of the unit texts", () => {
    const units = buildSpokenUnits(script);
    assert.equal(spokenCharacterCount(units), units.reduce((a, u) => a + u.text.length, 0));
  });

  test("each unit carries a stable sha256 of its exact text", () => {
    for (const u of buildSpokenUnits(script)) {
      assert.match(u.sha256, /^[0-9a-f]{64}$/);
    }
  });
});

describe("WC canary — duration envelope before spend", () => {
  const range = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");

  test("the WC production envelope is the grounded observed range", () => {
    assert.equal(range.minS, 210);
    assert.equal(range.maxS, 340);
  });

  test("the envelope is computed from spoken characters at the WC speaking rate", () => {
    const script = {
      hook: "H", cta: "C",
      segments: [{ segmentIndex: 0, title: "t", narration: "N", visual_prompt: "v", duration_seconds: 1 }],
      estimatedTotalDuration: 1,
    };
    const env = wcDurationEnvelope(script as never);
    const units = buildSpokenUnits(script);
    const chars = spokenCharacterCount(units);
    assert.equal(env.submitChars, chars);
    assert.equal(env.narrationS, chars / CHARS_PER_SECOND["wet-circuit"]);
    assert.equal(env.videoS, env.narrationS + TITLE_CARD_S);
  });

  test("WC and AI Doom size the same script differently — rates are per channel", () => {
    const script = {
      hook: "Hook text here.", cta: "CTA text here.",
      segments: [{ segmentIndex: 0, title: "t", narration: "Some narration.", visual_prompt: "v", duration_seconds: 1 }],
      estimatedTotalDuration: 1,
    };
    const wc = wcDurationEnvelope(script as never);
    // The AI Doom side is computed from the shared per-channel rate rather
    // than through a WC module, so this test never couples the two channels.
    const chars = spokenCharacterCount(buildSpokenUnits(script));
    const aiNarrationS = chars / CHARS_PER_SECOND["ai-doom-scroll"];
    assert.equal(wc.submitChars, chars, "the same bytes are submitted");
    assert.ok(wc.narrationS < aiNarrationS, "WC's voice is faster, so the same text is shorter");
  });

  test("a script too short for the envelope is outside it", () => {
    const chars = 100;
    const videoS = chars / CHARS_PER_SECOND["wet-circuit"] + TITLE_CARD_S;
    assert.ok(videoS < range.minS, "a 100-char script must not pass the envelope");
  });

  test("a script too long for the envelope is outside it", () => {
    const chars = 8000;
    const videoS = chars / CHARS_PER_SECOND["wet-circuit"] + TITLE_CARD_S;
    assert.ok(videoS > range.maxS, "an 8000-char script must not pass the envelope");
  });

  test("the character budget for the middle of the range lands inside it", () => {
    const chars = Math.round((range.midS - TITLE_CARD_S) * CHARS_PER_SECOND["wet-circuit"]);
    const videoS = chars / CHARS_PER_SECOND["wet-circuit"] + TITLE_CARD_S;
    assert.ok(videoS >= range.minS && videoS <= range.maxS);
  });
});

// ── Timezone / execution window (Phase 5) ─────────────────────────────────

describe("WC canary — execution window is Mon/Wed/Fri 17:00-20:00 America/New_York", () => {
  test("the canary declares Monday, Wednesday and Friday", () => {
    assert.deepEqual(WC_CANARY.windowDays, [1, 3, 5]);
    assert.equal(WC_CANARY.windowStartHour, 17);
    assert.equal(WC_CANARY.windowEndHour, 20);
    assert.equal(WC_CANARY.timezone, "America/New_York");
  });

  // EDT (UTC-4): 17:00 local == 21:00 UTC
  test("EDT — Monday 17:00 local is inside the window", () => {
    const d = new Date("2026-08-03T21:00:00Z"); // Mon 5:00 PM EDT
    assert.equal(zonedParts(d, "America/New_York").hour, 17);
    assert.ok(isDst(d, "America/New_York"), "August is daylight time");
    assert.ok(isInWindow(d, WC_WINDOW));
  });

  test("EDT — Monday 16:59 local is outside", () => {
    assert.equal(isInWindow(new Date("2026-08-03T20:59:00Z"), WC_WINDOW), false);
  });

  test("EDT — Monday 20:00 local is outside (end hour is exclusive)", () => {
    const d = new Date("2026-08-04T00:00:00Z"); // Mon 8:00 PM EDT
    assert.equal(zonedParts(d, "America/New_York").hour, 20);
    assert.equal(isInWindow(d, WC_WINDOW), false);
  });

  test("EDT — Wednesday 19:59 local is inside", () => {
    const d = new Date("2026-08-05T23:59:00Z"); // Wed 7:59 PM EDT
    assert.equal(zonedParts(d, "America/New_York").weekday, 3);
    assert.ok(isInWindow(d, WC_WINDOW));
  });

  test("EDT — Friday 17:00 local is inside", () => {
    const d = new Date("2026-08-07T21:00:00Z"); // Fri 5 PM EDT
    assert.equal(zonedParts(d, "America/New_York").weekday, 5);
    assert.ok(isInWindow(d, WC_WINDOW));
  });

  test("EDT — Tuesday 17:00 local is outside: not a window day", () => {
    const d = new Date("2026-08-04T21:00:00Z"); // Tue 5 PM EDT
    assert.equal(zonedParts(d, "America/New_York").hour, 17);
    assert.equal(isInWindow(d, WC_WINDOW), false);
  });

  test("EDT — Tuesday, Thursday, Saturday and Sunday are all outside", () => {
    // The superseded schedule allowed Tue/Thu; those days must now refuse.
    // Tue 2026-08-04, Thu 2026-08-06, Sat 2026-08-08, Sun 2026-08-09, 17:00 EDT.
    for (const iso of ["2026-08-04T21:00:00Z", "2026-08-06T21:00:00Z",
                       "2026-08-08T21:00:00Z", "2026-08-09T21:00:00Z"]) {
      assert.equal(isInWindow(new Date(iso), WC_WINDOW), false, `${iso} must be outside`);
    }
  });

  // EST (UTC-5): 17:00 local == 22:00 UTC
  test("EST — Monday 17:00 local is inside the window", () => {
    const d = new Date("2026-01-05T22:00:00Z"); // Mon 5:00 PM EST
    assert.equal(zonedParts(d, "America/New_York").hour, 17);
    assert.equal(isDst(d, "America/New_York"), false, "January is standard time");
    assert.ok(isInWindow(d, WC_WINDOW));
  });

  test("EST — the EDT instant is NOT inside in winter: a fixed offset would be wrong", () => {
    // 21:00 UTC is 5 PM in EDT but 4 PM in EST. A hardcoded UTC hour silently
    // moves the local window by an hour twice a year.
    const winter = new Date("2026-01-05T21:00:00Z"); // Mon 4:00 PM EST
    assert.equal(zonedParts(winter, "America/New_York").hour, 16);
    assert.equal(isInWindow(winter, WC_WINDOW), false);
  });

  test("EST — Friday 17:00 local is inside", () => {
    const d = new Date("2026-01-09T22:00:00Z");
    assert.equal(zonedParts(d, "America/New_York").weekday, 5);
    assert.ok(isInWindow(d, WC_WINDOW));
  });

  // DST transitions
  test("DST spring-forward — the window is still 17:00-20:00 local", () => {
    // 2026-03-08 is the spring transition (a Sunday). The following Monday is
    // the 9th, already on EDT.
    const mon = new Date("2026-03-09T21:00:00Z"); // Mon 5 PM EDT
    assert.ok(isDst(mon, "America/New_York"));
    assert.equal(zonedParts(mon, "America/New_York").hour, 17);
    assert.ok(isInWindow(mon, WC_WINDOW));
  });

  test("DST fall-back — the window is still 17:00-20:00 local", () => {
    // 2026-11-01 is the autumn transition (a Sunday). The following Monday is
    // the 2nd, back on EST.
    const mon = new Date("2026-11-02T22:00:00Z"); // Mon 5 PM EST
    assert.equal(isDst(mon, "America/New_York"), false);
    assert.equal(zonedParts(mon, "America/New_York").hour, 17);
    assert.ok(isInWindow(mon, WC_WINDOW));
  });

  test("the window day either side of each transition lands on the same local hour", () => {
    // Fri 2026-03-06 (EST), Mon 2026-03-09 (EDT),
    // Fri 2026-10-30 (EDT), Mon 2026-11-02 (EST).
    for (const iso of ["2026-03-06T22:00:00Z", "2026-03-09T21:00:00Z",
                       "2026-10-30T21:00:00Z", "2026-11-02T22:00:00Z"]) {
      const d = new Date(iso);
      assert.equal(zonedParts(d, "America/New_York").hour, 17, `${iso} must read 17:00 local`);
      assert.ok(isInWindow(d, WC_WINDOW), `${iso} must be inside the window`);
    }
  });

  test("nextWindowStart lands on a Monday, Wednesday or Friday at 17:00 local", () => {
    for (const from of ["2026-08-03T12:00:00Z", "2026-01-01T12:00:00Z", "2026-11-02T12:00:00Z"]) {
      const next = nextWindowStart(new Date(from), WC_WINDOW);
      const p = zonedParts(next, "America/New_York");
      assert.ok([1, 3, 5].includes(p.weekday), `${from} → ${formatZoned(next)} must be Mon, Wed or Fri`);
      assert.equal(p.hour, 17, `${from} → ${formatZoned(next)} must open at 17:00 local`);
      assert.ok(next > new Date(from), "the next window must be in the future");
    }
  });

  test("an execution window instant is never handed to the upload as a publish time", () => {
    // The window says WHEN THE PIPELINE MAY RUN. The upload policy for a pilot
    // carries no slot regardless of when the run happens.
    const insideWindow = new Date("2026-08-03T21:00:00Z");
    assert.ok(isInWindow(insideWindow, WC_WINDOW));
    const policy = uploadPolicyFor(active(), nextWindowStart(insideWindow, WC_WINDOW));
    assert.equal(policy.scheduledSlot, null,
      "the execution window must never become a YouTube publishAt");
    assert.doesNotThrow(() => assertPilotUploadAllowed(policy, null));
  });
});

// ── A/G. Guarded durable upload, WC's own implementation ──────────────────
//
// This coverage previously lived as edits to tests/pilot-controls.test.ts,
// which pins AI Doom's baseline upload stage. AI Doom has been restored to
// baseline and keeps its own inline implementation, so the WC equivalent is
// asserted here instead — against WC's files only.

describe("WC pilot upload is guarded, durable and slot-safe", () => {
  const pilotUpload = readFileSync("packages/wc-pipeline/src/stages/pilotUpload.ts", "utf8");
  const upload = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");

  test("the pilot branch is reached before the direct insert", () => {
    const guarded = upload.indexOf("runWcPilotUpload(");
    const raw = upload.indexOf("youtube.videos.insert(");
    assert.ok(guarded > 0 && raw > 0 && guarded < raw,
      "the guarded path must be reached before the direct insert");
    assert.match(upload, /policy\.source === "pilot" && policy\.requireGuardedUpload/);
  });

  test("the pilot branch returns, so the raw insert is unreachable for a canary", () => {
    const guarded = upload.indexOf("runWcPilotUpload(");
    const raw = upload.indexOf("youtube.videos.insert(");
    const branch = upload.slice(guarded, raw);
    assert.match(branch, /return\s*\{[\s\S]*success: true/,
      "the pilot branch must return rather than fall through to the insert");
  });

  test("the upload goes through the intent-backed uploader", () => {
    assert.match(pilotUpload, /await guardedUpload\(/);
    assert.match(pilotUpload, /store: prismaIntentStore/);
    assert.match(pilotUpload, /sourceTable: "wc_video"/,
      "the intent must name WC's own table");
  });

  test("the artifact is bound by file and manifest hash", () => {
    assert.match(pilotUpload, /await sha256File\(deps\.videoPath\)/);
    assert.match(pilotUpload, /sha256Manifest\(await sceneRecordsFor\(deps\.videoId\)/);
    assert.match(pilotUpload, /actualFileSha256: fileSha256/);
    assert.match(pilotUpload, /actualManifestSha256: manifestSha256/);
  });

  test("a failed upload releases its slot, in the catch and not on success", () => {
    assert.match(pilotUpload, /await releasePilotSlot\(pilot\.pilotId\)/);
    const catchBlock = pilotUpload.slice(pilotUpload.indexOf("} catch (err) {"));
    assert.match(catchBlock, /releasePilotSlot/,
      "the slot must be released when the upload does not complete");
    // Scope past the import block: releasePilotSlot is named there by necessity.
    const body = pilotUpload.slice(pilotUpload.indexOf("export async function runWcPilotUpload"));
    const beforeCatch = body.slice(0, body.indexOf("} catch (err) {"));
    assert.doesNotMatch(beforeCatch, /releasePilotSlot/,
      "a successful upload must not release its slot");
  });

  test("the slot is claimed before any bytes move", () => {
    const claim = pilotUpload.indexOf("claimPilotSlot(");
    const upload_ = pilotUpload.indexOf("guardedUpload(");
    assert.ok(claim > 0 && upload_ > 0 && claim < upload_,
      "the cap must be claimed before the remote call, not after");
  });

  test("privacy and publishAt are pinned, not taken from the caller", () => {
    assert.match(pilotUpload, /privacyStatus: "private"/);
    assert.match(pilotUpload, /publishAt: null/);
  });

  test("a non-pilot policy is refused outright", () => {
    assert.match(pilotUpload, /NOT_A_PILOT/);
  });

  test("WC's pilot module is WC-owned and not imported by AI Doom", () => {
    const aiUpload = readFileSync("packages/pipeline-core/src/stages/youtubeUpload.ts", "utf8");
    const aiPipeline = readFileSync("src/pipeline.ts", "utf8");
    for (const [name, src] of [["pipeline-core upload", aiUpload], ["AI Doom pipeline", aiPipeline]] as const) {
      assert.doesNotMatch(src, /wc-pipeline/, `${name} must not reference WC modules`);
      assert.doesNotMatch(src, /runWcPilotUpload|wcVisualFeasibilityGate|wcFinalVideoQa/,
        `${name} must not import WC stages`);
    }
  });
});
