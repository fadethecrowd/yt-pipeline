import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { STAGES, selectStages } from "../src/pipeline";
import { uploadPolicyFor } from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";

/**
 * A tranche said "Shorts disabled" and the pipeline made a Short anyway.
 *
 * On 2026-08-16 candidate cmsw31q0v0001mb0ybuc0jvkn uploaded its long-form
 * successfully and then entered `shortsGenerator`, which built a Short locally,
 * reached for YouTube credentials, and failed on `invalid_grant`. Nothing was
 * uploaded, but the work happened and the run carried a bogus failure.
 *
 * There were two sources of Shorts policy:
 *
 *   - the stage list's `skipDuringPilot`, which drops the stage for a PILOT and
 *     does nothing for ordinary production
 *   - the tranche's `shortsEnabled`, read only inside `youtubeUpload`, where it
 *     shapes the long-form upload policy
 *
 * Ordinary production has no pilot, so nothing consulted the tranche before
 * running the stage.
 *
 * These tests drive the REAL stage list and the REAL selector the pipeline
 * calls — not a reimplementation — because a helper-only test is exactly what
 * missed this.
 */

const PILOT: PilotConfig = {
  id: "row", pilotId: "ai-doom-private-pilot-1", channel: "ai-doom-scroll", channelId: "UC",
  status: "COMPLETED", maxSuccesses: 2, successCount: 2, successVideoIds: ["a", "b"],
  activatedAt: new Date(), completedAt: new Date(), privacyStatus: "private",
  allowPublishAt: false, shortsEnabled: false, requireFeasibility: true,
  requireGuardedUpload: true, windowDays: [1, 3, 5], windowStartHour: 17,
  windowEndHour: 20, timezone: "America/New_York",
};

const names = (s: { name: string }[]) => s.map((x) => x.name);

describe("shortsEnabled=false bypasses the Shorts stage entirely", () => {
  test("the real stage list contains exactly one Shorts stage", () => {
    assert.equal(STAGES.filter((s) => s.name === "shortsGenerator").length, 1);
  });

  test("1/2/3/4/5. ordinary production with Shorts off never reaches the stage", () => {
    const chosen = selectStages(STAGES, { isPilot: false, shortsEnabled: false });
    assert.ok(!names(chosen).includes("shortsGenerator"),
      "the stage must be absent, so nothing it does can happen at all");
    // The long-form path is untouched.
    for (const kept of ["scriptGenerator", "qualityGate", "visualFeasibilityGate",
                        "videoAssembly", "thumbnailGenerator", "seoGenerator",
                        "finalVideoQa", "youtubeUpload"]) {
      assert.ok(names(chosen).includes(kept), `${kept} must still run`);
    }
  });

  test("absence is what prevents generation, auth, upload and artifacts", () => {
    // Every Shorts side effect lives inside the stage function, so a stage that
    // is never selected cannot generate, authenticate, upload or write a file.
    //
    // The authentication marker is `buildYouTubeClient` rather than
    // `google.auth.OAuth2`: the stage no longer constructs its own credential.
    // It used to, and that is precisely the bug — it verified the channel
    // through pipeline-core's builder and then inserted on a second, dead
    // credential. What this assertion cares about is unchanged: an
    // authenticating call is inside the stage body.
    const src = readFileSync("src/stages/shortsGenerator.ts", "utf8");
    for (const sideEffect of ["buildYouTubeClient", "ffmpeg", "writeFile"]) {
      assert.ok(src.includes(sideEffect),
        `${sideEffect} is inside the stage — which is why the stage must not be selected`);
    }
    const chosen = selectStages(STAGES, { isPilot: false, shortsEnabled: false });
    assert.ok(!chosen.some((s) => s.execute === STAGES.find((x) => x.name === "shortsGenerator")!.execute),
      "the stage function itself must not appear in the selected list");
  });

  test("positive path: an authorising tranche still reaches Shorts", () => {
    const chosen = selectStages(STAGES, { isPilot: false, shortsEnabled: true });
    assert.ok(names(chosen).includes("shortsGenerator"),
      "future Shorts functionality must be preserved");
  });

  test("pilot behaviour is unchanged — a pilot never makes Shorts", () => {
    for (const shortsEnabled of [false, true]) {
      const chosen = selectStages(STAGES, { isPilot: true, shortsEnabled });
      assert.ok(!names(chosen).includes("shortsGenerator"), `shortsEnabled=${shortsEnabled}`);
    }
    // And every other skipDuringPilot stage is still dropped for a pilot.
    const pilotSkipped = STAGES.filter((s) => s.skipDuringPilot).map((s) => s.name);
    const chosen = names(selectStages(STAGES, { isPilot: true, shortsEnabled: false }));
    for (const n of pilotSkipped) assert.ok(!chosen.includes(n), `${n} must stay skipped for a pilot`);
  });

  test("no other stage is added or removed by the selector", () => {
    const on = names(selectStages(STAGES, { isPilot: false, shortsEnabled: true }));
    assert.deepEqual(on, names(STAGES), "with Shorts on, ordinary production runs the full list");
    const off = names(selectStages(STAGES, { isPilot: false, shortsEnabled: false }));
    assert.deepEqual(off, names(STAGES).filter((n) => n !== "shortsGenerator"),
      "with Shorts off, exactly one stage is removed");
  });

  test("6/7/8. the pipeline resolves the policy from the tranche, before any stage runs", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    assert.match(src, /const shortsEnabled = pilot\s*\n?\s*\?\s*false\s*\n?\s*:\s*\(await currentTranche\(AI_DOOM_CHANNEL\)\)\?\.shortsEnabled \?\? false/);
    assert.match(src, /selectStages\(STAGES, \{ isPilot: !!pilot, shortsEnabled \}\)/);
    assert.match(src, /SHORTS: SKIPPED_DISABLED/);
    // Resolved before the stage loop, and before any candidate work.
    assert.ok(src.indexOf("const shortsEnabled = pilot") < src.indexOf("for (const stage of resumeStages)"));
    assert.ok(src.indexOf("const shortsEnabled = pilot") < src.indexOf("for (const stage of stages.slice(1))"));
    // Nothing about tranche accounting or scheduling is touched here.
    const block = src.slice(src.indexOf("const shortsEnabled = pilot"),
      src.indexOf("// ── Check for stuck videos"));
    for (const forbidden of ["claimSlot", "settleSlot", "nextPublishSlot", "consumedCandidates"]) {
      assert.ok(!block.includes(forbidden), `stage selection must not touch ${forbidden}`);
    }
  });

  test("the two policy sources now agree instead of diverging", () => {
    // uploadPolicyFor already defaulted a non-pilot run to Shorts off; the
    // selector now uses the same rule, so the upload policy and the stage list
    // can no longer disagree.
    assert.equal(uploadPolicyFor(null, new Date(), null).shortsEnabled, false);
    assert.equal(uploadPolicyFor(null, new Date(), { shortsEnabled: false }).shortsEnabled, false);
    assert.equal(uploadPolicyFor(null, new Date(), { shortsEnabled: true }).shortsEnabled, true);
    assert.equal(uploadPolicyFor(PILOT, new Date()).shortsEnabled, false);
  });

  test("long-form upload policy is unchanged: private with a future publishAt", () => {
    const slot = new Date("2026-08-19T19:00:00.000Z");
    const p = uploadPolicyFor(null, slot, { shortsEnabled: false });
    assert.equal(p.privacyStatus, "private");
    assert.equal(p.scheduledSlot, slot);
    assert.equal(p.requireGuardedUpload, true);
  });
});

// ── Staged inventory is not a preflight fault ────────────────────────────

describe("preflight distinguishes staged inventory from a collision", () => {
  const PRE = readFileSync("scripts/monday-preflight.ts", "utf8");

  test("a future scheduled video no longer fails preflight on its own", () => {
    assert.ok(!PRE.includes("snap.futureScheduled.length === 0"),
      "ordinary production stages inventory by design; zero-scheduled was a pilot-era assertion");
  });

  test("two videos sharing a slot still fail", () => {
    assert.match(PRE, /no publication collision \(one video per slot\)/);
    assert.match(PRE, /filter\(\(\[, n\]\) => n > 1\)/);
  });

  test("the scheduler's own collision guard is untouched", () => {
    const ctrl = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.match(ctrl, /nextPublishSlot\(now, \{ occupied \}\)/);
    assert.match(ctrl, /occupied future slots/);
  });
});
