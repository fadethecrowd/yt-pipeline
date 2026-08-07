import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  qualityProfile, runtimeRange, MAX_CONCEPT_SHARE, zonedParts,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, Script } from "@yt-pipeline/pipeline-core";
import {
  WC_CANARY_AUTHORIZATIONS, resolveWcCanaryAuthorization, assertWcCanaryWindow,
  evaluateWcCanaryWindow, findWcCanaryAuthorization, scriptSha256,
  WcCanaryAuthorizationError,
} from "../packages/wc-pipeline/src/canary/authorization";
import { armTransitionSql } from "../scripts/wc-canary-control";

/**
 * The private-canary activation controls.
 *
 * Two things were advisory and are now not: the execution window logged a
 * violation and continued, and the relaxed quality profile had no durable
 * authorisation binding it to one candidate. Both now refuse.
 */

const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;

const PILOT: PilotConfig = {
  id: "row-1", pilotId: AUTH.pilotId,
  channel: "wet-circuit", channelId: AUTH.channelId,
  status: "PREPARED", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: null, completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [2, 4], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

/** The real script, read from the tracked fixture of the measured candidate. */
const SCRIPT: Script = JSON.parse(
  readFileSync("tests/fixtures/wc-canary-script.json", "utf8"),
) as Script;

const base = () => ({
  pilot: PILOT, candidateId: AUTH.candidateId, script: SCRIPT, submitChars: 4164,
});

const codeOf = (fn: () => unknown): string => {
  try { fn(); return "NO_THROW"; }
  catch (e) { return e instanceof WcCanaryAuthorizationError ? e.code : `OTHER:${(e as Error).message}`; }
};

// ── A. WINDOW ────────────────────────────────────────────────────────────

describe("A. execution window is fail-closed", () => {
  const at = (iso: string) => new Date(iso);
  const allow = (iso: string) => evaluateWcCanaryWindow(at(iso), AUTH).allowed;

  // EDT (UTC-4): 17:00 local == 21:00 UTC. Aug 11 2026 is a Tuesday.
  test("Tuesday 16:59:59 ET → refuse", () => {
    assert.equal(allow("2026-08-11T20:59:59Z"), false);
  });
  test("Tuesday 17:00:00 ET → allow", () => {
    const d = at("2026-08-11T21:00:00Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 17);
    assert.equal(allow("2026-08-11T21:00:00Z"), true);
  });
  test("Tuesday mid-window 18:30 ET → allow", () => {
    assert.equal(allow("2026-08-11T22:30:00Z"), true);
  });
  test("Tuesday 19:59:59 ET → allow (end hour exclusive, existing convention)", () => {
    const d = at("2026-08-11T23:59:59Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 19);
    assert.equal(allow("2026-08-11T23:59:59Z"), true);
  });
  test("Tuesday 20:00:00 ET → refuse (end boundary is exclusive)", () => {
    const d = at("2026-08-12T00:00:00Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 20);
    assert.equal(allow("2026-08-12T00:00:00Z"), false);
  });
  test("Tuesday 20:00:01 ET → refuse", () => {
    assert.equal(allow("2026-08-12T00:00:01Z"), false);
  });

  // Thursday 2026-08-13
  test("Thursday 16:59 ET → refuse", () => assert.equal(allow("2026-08-13T20:59:00Z"), false));
  test("Thursday 17:00 ET → allow", () => assert.equal(allow("2026-08-13T21:00:00Z"), true));
  test("Thursday 19:59 ET → allow", () => assert.equal(allow("2026-08-13T23:59:00Z"), true));
  test("Thursday 20:00 ET → refuse", () => assert.equal(allow("2026-08-14T00:00:00Z"), false));

  test("every non-window weekday at 18:00 ET refuses", () => {
    // Mon 10th, Wed 12th, Fri 14th, Sat 15th, Sun 16th August 2026, 18:00 EDT.
    const days: [string, string][] = [
      ["Monday", "2026-08-10T22:00:00Z"], ["Wednesday", "2026-08-12T22:00:00Z"],
      ["Friday", "2026-08-14T22:00:00Z"], ["Saturday", "2026-08-15T22:00:00Z"],
      ["Sunday", "2026-08-16T22:00:00Z"],
    ];
    for (const [name, iso] of days) {
      assert.equal(allow(iso), false, `${name} must refuse`);
    }
  });

  test("today (Friday 7 August 2026) refuses", () => {
    assert.equal(allow("2026-08-07T22:00:00Z"), false);
  });

  test("winter EST Tuesday 17:00 → allow; the EDT instant does NOT", () => {
    // 2026-01-06 is a Tuesday. EST is UTC-5, so 17:00 local == 22:00 UTC.
    assert.equal(zonedParts(at("2026-01-06T22:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-01-06T22:00:00Z"), true);
    // 21:00 UTC is 16:00 EST — a fixed offset would wrongly admit it.
    assert.equal(zonedParts(at("2026-01-06T21:00:00Z"), "America/New_York").hour, 16);
    assert.equal(allow("2026-01-06T21:00:00Z"), false);
  });

  test("summer EDT Tuesday 17:00 → allow", () => {
    assert.equal(allow("2026-08-11T21:00:00Z"), true);
  });

  test("both 2026 DST transitions keep the window at 17:00-20:00 local", () => {
    // Spring forward 2026-03-08; following Tuesday is the 10th (EDT).
    assert.equal(zonedParts(at("2026-03-10T21:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-03-10T21:00:00Z"), true);
    // Tuesday before the transition, 2026-03-03, is EST.
    assert.equal(zonedParts(at("2026-03-03T22:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-03-03T22:00:00Z"), true);
    // Fall back 2026-11-01; following Tuesday is the 3rd (EST).
    assert.equal(zonedParts(at("2026-11-03T22:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-11-03T22:00:00Z"), true);
    // Tuesday before, 2026-10-27, is EDT.
    assert.equal(zonedParts(at("2026-10-27T21:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-10-27T21:00:00Z"), true);
  });

  test("the host's own timezone cannot change the decision", () => {
    const inside = at("2026-08-11T21:00:00Z");
    const before = process.env.TZ;
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      assert.equal(evaluateWcCanaryWindow(inside, AUTH).allowed, true, `TZ=${tz}`);
      assert.equal(evaluateWcCanaryWindow(at("2026-08-10T22:00:00Z"), AUTH).allowed, false, `TZ=${tz}`);
    }
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  });

  test("assert form throws with CANARY_OUTSIDE_WINDOW", () => {
    assert.equal(codeOf(() => assertWcCanaryWindow(at("2026-08-07T22:00:00Z"), AUTH)),
      "CANARY_OUTSIDE_WINDOW");
    assert.doesNotThrow(() => assertWcCanaryWindow(at("2026-08-11T21:00:00Z"), AUTH));
  });

  test("malformed window configuration fails closed", () => {
    const bad = (w: Partial<typeof AUTH.window>) =>
      codeOf(() => assertWcCanaryWindow(at("2026-08-11T21:00:00Z"), { ...AUTH, window: { ...AUTH.window, ...w } }));
    assert.equal(bad({ days: [] }), "CANARY_WINDOW_MALFORMED");
    assert.equal(bad({ days: [9] }), "CANARY_WINDOW_MALFORMED");
    assert.equal(bad({ startHour: 20, endHour: 17 }), "CANARY_WINDOW_MALFORMED");
    assert.equal(bad({ startHour: -1 }), "CANARY_WINDOW_MALFORMED");
    assert.equal(bad({ timezone: "Not/AZone" }), "CANARY_WINDOW_MALFORMED");
  });

  test("the root path refuses rather than logging", () => {
    const pipeline = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.match(pipeline, /assertWcCanaryWindow\(new Date\(\), canaryAuth\)/,
      "an authorised canary must be asserted, not logged");
    // And the assertion happens inside the pilot gate, before any candidate work.
    const gateIdx = pipeline.indexOf("assertWcCanaryWindow");
    const discoveryIdx = pipeline.indexOf("const discoveryStage = stages[0]");
    const resumeIdx = pipeline.indexOf("const stuckVideo = await prisma.wcVideo.findFirst");
    assert.ok(gateIdx > 0 && gateIdx < resumeIdx && gateIdx < discoveryIdx,
      "the window check must precede resume and discovery");
  });
});

// ── B. AUTHORIZATION ─────────────────────────────────────────────────────

describe("B. authorization binds one candidate and fails closed", () => {
  test("the exact match resolves and yields the profile-owned tolerance", () => {
    const r = resolveWcCanaryAuthorization(base())!;
    assert.ok(r);
    assert.equal(r.qualityProfileName, "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY");
    assert.equal(r.effectiveMaxConceptShare,
      qualityProfile("FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY").maxConceptShare);
    assert.equal(r.effectiveMaxConceptShare, 0.6);
    assert.equal(r.scriptSha256, AUTH.scriptSha256);
  });

  test("an unlisted pilot is not a canary — returns null, meaning strict", () => {
    const r = resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, pilotId: "ai-doom-private-pilot-1" },
    });
    assert.equal(r, null, "absence of authorisation means strict, not an error");
  });

  test("wrong candidate → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({ ...base(), candidateId: "cmOTHER" })),
      "CANARY_WRONG_CANDIDATE");
  });

  test("wrong script hash → refuse", () => {
    const drifted = { ...SCRIPT, hook: `${SCRIPT.hook} (edited)` };
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({ ...base(), script: drifted })),
      "CANARY_SCRIPT_DRIFT");
  });

  test("wrong channel → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, channelId: "UCSbJfiA1aobp6G_rgwbHPMw" },
    })), "CANARY_WRONG_CHANNEL");
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, channel: "ai-doom-scroll" },
    })), "CANARY_WRONG_CHANNEL");
  });

  test("narration above the 4164 ceiling → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({ ...base(), submitChars: 4165 })),
      "CANARY_NARRATION_CEILING");
    assert.ok(resolveWcCanaryAuthorization({ ...base(), submitChars: 4164 }), "exactly at the ceiling is allowed");
  });

  test("a non-positive narration count → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({ ...base(), submitChars: 0 })),
      "CANARY_BAD_NARRATION_COUNT");
  });

  test("non-private policy → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, privacyStatus: "unlisted" },
    })), "CANARY_NOT_PRIVATE");
  });

  test("publishAt permitted → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, allowPublishAt: true },
    })), "CANARY_ALLOWS_PUBLISH");
  });

  test("maxSuccesses != 1 → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, maxSuccesses: 3 },
    })), "CANARY_WRONG_CAP");
  });

  test("Shorts enabled or controls disabled → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, shortsEnabled: true },
    })), "CANARY_SHORTS_ENABLED");
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, requireGuardedUpload: false },
    })), "CANARY_CONTROLS_DISABLED");
  });

  test("a pilot window that drifts from the authorisation → refuse", () => {
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, windowDays: [1, 3, 5] },
    })), "CANARY_WINDOW_MISMATCH");
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, timezone: "UTC" },
    })), "CANARY_WINDOW_MISMATCH");
  });

  test("the runtime envelope is asserted against the canonical source", () => {
    const range = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
    assert.equal(AUTH.runtimeMinS, range.minS);
    assert.equal(AUTH.runtimeMaxS, range.maxS);
  });

  test("an unknown profile name in an authorisation would refuse", () => {
    const bad = { ...AUTH, qualityProfileName: "NOPE" as never };
    assert.throws(() => qualityProfile(bad.qualityProfileName), /unknown quality profile/);
  });

  test("the manifest names the profile and never restates 0.60", () => {
    const src = readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8");
    assert.match(src, /qualityProfileName: "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY"/);
    assert.doesNotMatch(src, /0\.6\b/, "the tolerance value is owned by qualityProfile.ts");
    assert.match(src, /qualityProfile\(auth\.qualityProfileName\)/);
  });

  test("exactly one canary is authorised", () => {
    assert.equal(WC_CANARY_AUTHORIZATIONS.length, 1);
    assert.ok(findWcCanaryAuthorization(AUTH.pilotId));
    assert.equal(findWcCanaryAuthorization("nope"), undefined);
  });

  test("the authorisation carries its rationale", () => {
    assert.ok(AUTH.rationale.length > 100, "the authorising reason is recorded in-tree");
  });
});

// ── C. ROOT PROFILE WIRING ───────────────────────────────────────────────

describe("C. relaxation is unreachable except for the exact canary", () => {
  const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");

  test("ordinary WC starts strict", () => {
    assert.match(gate, /let tieAware: TieAwareOptions = \{\};/);
  });

  test("PILOT_ID alone cannot relax — the resolver requires candidate and script too", () => {
    const src = readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8");
    assert.match(src, /auth\.candidateId !== input\.candidateId/);
    assert.match(src, /actualHash !== auth\.scriptSha256/);
    // A pilot that IS authorised but with the wrong candidate refuses outright.
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({ ...base(), candidateId: "other" })),
      "CANARY_WRONG_CANDIDATE");
  });

  test("a candidate id alone cannot relax — an unlisted pilot yields strict", () => {
    assert.equal(resolveWcCanaryAuthorization({
      ...base(), pilot: { ...PILOT, pilotId: "some-other-pilot" },
    }), null);
  });

  test("the profile cannot leak to another WC row", () => {
    // Same pilot, different candidate → refuse, never silently relaxed.
    assert.equal(codeOf(() => resolveWcCanaryAuthorization({
      ...base(), candidateId: "cmshzj6cx0006mbqi8u9bszzz",
    })), "CANARY_WRONG_CANDIDATE");
  });

  test("the profile cannot leak to AI Doom", () => {
    for (const f of ["src/stages/visualFeasibilityGate.ts", "src/pipeline.ts",
                     "packages/pipeline-core/src/stages/youtubeUpload.ts"]) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /canary\/authorization|resolveWcCanaryAuthorization|WC_CANARY/,
        `${f} must not reference WC canary authorisation`);
    }
  });

  test("no unrelated profile relaxation is enabled", () => {
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    for (const field of ["maxPerShootCluster", "maxAerialShare", "maxCardShare", "allowConceptualBRoll"]) {
      assert.doesNotMatch(acct, new RegExp(`\\.${field}\\b`), `${field} must stay strict`);
    }
    const vf = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(vf, /export const MAX_CARD_SHARE = 0\.15/);
    assert.doesNotMatch(vf, /qualityProfile/, "the shared gate consults no profile");
  });

  test("MAX_CONCEPT_SHARE is still 0.40", () => {
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
  });

  test("longestNoNewConceptRun remains diagnostic", () => {
    const failBlock = gate.slice(gate.indexOf("if (failed.length > 0)"));
    assert.doesNotMatch(failBlock, /longestNoNewConceptRun|monotony/i);
  });
});

// ── D. REUSE (design only — nothing executed) ────────────────────────────

describe("D. the controlled reuse transition is compare-and-set", () => {
  const sql = armTransitionSql();

  test("target status is the pre-feasibility state qualityGate leaves", () => {
    assert.match(sql, /SET "status" = 'VOICEOVER_PENDING'/);
    const qg = readFileSync("packages/wc-pipeline/src/stages/qualityGate.ts", "utf8");
    assert.match(qg, /status: VideoStatus\.VOICEOVER_PENDING/,
      "qualityGate leaves a passing candidate exactly here, immediately before feasibility");
  });

  test("that status is deliberately NOT resumable by the generic runner", () => {
    const pipeline = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    const map = pipeline.slice(pipeline.indexOf("const RESUME_FROM"), pipeline.indexOf("/** Fails closed"));
    assert.doesNotMatch(map, /VOICEOVER_PENDING/,
      "adding it would arm every crashed-mid-narration row for an unattended re-spend");
  });

  test("stale status refuses — the WHERE pins QUALITY_FAILED", () => {
    assert.match(sql, /AND "status" = 'QUALITY_FAILED'/);
  });

  test("quality and script are pinned, not regenerated", () => {
    assert.match(sql, /AND "qualityScore" = 88/);
    assert.match(sql, /AND "scriptJson" IS NOT NULL/);
    assert.doesNotMatch(sql, /"scriptJson" =/, "the script is never rewritten");
    assert.doesNotMatch(sql, /"topicId" =/, "the topic is never changed");
  });

  test("existing narration, render or upload refuses", () => {
    assert.match(sql, /AND "voiceoverPath" IS NULL/);
    assert.match(sql, /AND "videoPath" IS NULL/);
    assert.match(sql, /AND "youtubeId" IS NULL/);
    assert.match(sql, /AND "scheduledAt" IS NULL/);
    assert.match(sql, /AND "shortsUrl" IS NULL/);
  });

  test("it is an UPDATE of one row, never an INSERT", () => {
    assert.match(sql, /^UPDATE "wc_video"/);
    assert.doesNotMatch(sql, /INSERT|DELETE/);
    assert.match(sql, /WHERE "id" = \$1/);
  });
});

// ── E. SAFETY ────────────────────────────────────────────────────────────

describe("E. safety controls a profile or window can never relax", () => {
  const pipeline = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
  const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
  const upload = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");
  const voice = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");

  test("no spend before feasibility — the gate precedes voiceover", () => {
    const feas = pipeline.indexOf('name: "visualFeasibilityGate"');
    const vo = pipeline.indexOf('name: "voiceover"');
    assert.ok(feas > 0 && vo > feas, "feasibility must precede narration");
    assert.match(gate, /await failCandidate\(ctx\.video\.id, reason\)/,
      "a failed gate marks the candidate and returns before any spend");
  });

  test("no upload before a persisted passing QA bound to the artifact", () => {
    assert.match(upload, /await assertWcFinalQaPassed\(ctx\.video\.id, video\.videoPath\)/);
    const gateIdx = upload.indexOf("assertWcFinalQaPassed(");
    assert.ok(gateIdx > 0 && gateIdx < upload.indexOf("youtube.videos.insert("));
  });

  test("PRIVATE and publishAt=null are enforced independently of any profile", () => {
    assert.match(upload, /assertPilotUploadAllowed\(policy, scheduledAt\)/);
    assert.doesNotMatch(upload, /qualityProfile|FINITE_CREDIT|canary\/authorization/);
  });

  test("the one-success cap is unaffected", () => {
    const pilotUpload = readFileSync("packages/wc-pipeline/src/stages/pilotUpload.ts", "utf8");
    assert.match(pilotUpload, /claimPilotSlot\(pilot\.pilotId\)/);
    assert.doesNotMatch(pilotUpload, /qualityProfile|canary\/authorization/);
    assert.equal(AUTH.maxSuccesses, 1);
  });

  test("one-active-run protection is unchanged", () => {
    assert.match(pipeline, /withAdvisoryLock\(prisma, WC_LOCK_ID/);
  });

  test("Shorts stay skipped during the canary", () => {
    assert.match(pipeline, /skipDuringPilot: true/);
    assert.match(pipeline, /STAGES\.filter\(\(s\) => !\(pilot && s\.skipDuringPilot\)\)/);
    assert.equal(AUTH.window.days.length, 2);
  });

  test("the narration budget window is independent of the profile", () => {
    assert.doesNotMatch(voice, /qualityProfile|FINITE_CREDIT|canary\/authorization/);
    assert.match(voice, /withBudgetWindow\(\s*"wet-circuit"/);
  });

  test("the control script defaults to CHECK and gates ARM/RUN", () => {
    const ctl = readFileSync("scripts/wc-canary-control.ts", "utf8");
    assert.match(ctl, /const PHASE = RUN \? "RUN" : ARM \? "ARM" : "CHECK"/);
    assert.match(ctl, /--i-understand-this-spends-credits/);
    assert.match(ctl, /RUN is not implemented/);
    // The tool PRINTS the operation ARM/RUN would perform; it must never
    // import or invoke it.
    assert.doesNotMatch(ctl, /import[^;]*setBudgetLimit/, "CHECK must not import the budget opener");
    assert.doesNotMatch(ctl, /await setBudgetLimit\(/, "CHECK must not open a budget");
    assert.doesNotMatch(ctl, /await prisma\.wcVideo\.update|await pilots\.update|\$executeRaw/,
      "no mutation is reachable in this build");
  });
});

// ── Script fixture integrity ─────────────────────────────────────────────

describe("the tracked script fixture is the authorised script", () => {
  test("its hash is exactly the authorised hash", () => {
    assert.equal(scriptSha256(SCRIPT), AUTH.scriptSha256);
    assert.equal(AUTH.scriptSha256,
      "7681ec18117f3255c18fd912b0c79390e70bcd0ae87618c6bd711891fb4d1259");
  });

  test("the narration it implies is exactly the authorised ceiling", async () => {
    const { buildSpokenUnits, spokenCharacterCount } =
      await import("@yt-pipeline/pipeline-core");
    assert.equal(spokenCharacterCount(buildSpokenUnits(SCRIPT)), AUTH.maxNarrationChars);
  });
});
