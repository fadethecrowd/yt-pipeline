import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MANUAL_SUPERVISED, UNATTENDED, windowApplies,
  schedulerTick, isSchedulerEnabled, SCHEDULER_ENABLED_VALUE,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS,
  nextPublishSlot, publicationPolicyFor, zonedParts,
  PilotBlockedError, isInWindow,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, SchedulerDeps } from "@yt-pipeline/pipeline-core";
import { evaluateAiDoomPilotWindow, assertAiDoomPilotWindow } from "../src/pilotBinding";
import {
  WC_CANARY_AUTHORIZATIONS, assertWcCanaryWindow, evaluateWcCanaryWindow,
} from "../packages/wc-pipeline/src/canary/authorization";
import { classifyPhase, doAdvanceCap, RUN_PLAN } from "../scripts/ai-doom-pilot-control";

/**
 * Removing the clock from MANUALLY SUPERVISED qualification — and proving that
 * is ALL it removed.
 *
 * The Mon/Wed/Fri 17:00-20:00 window bounded *unsupervised* risk. It never
 * applied to the manual controls, which cannot start anything without a person
 * typing a command and an acknowledgement flag. Operator availability is not
 * actually restricted to one evening, so the window was friction rather than
 * safety.
 *
 * What must remain true is everything the window was standing in front of, so
 * these tests are mostly about what did NOT change: the unattended scheduler,
 * the success cap, the spend gates and the relock.
 */

const read = (p: string) => readFileSync(p, "utf8");
const AI_PIPELINE = read("src/pipeline.ts");
const WC_PIPELINE = read("packages/wc-pipeline/src/pipeline.ts");
const SUPERVISION = read("packages/pipeline-core/src/lib/supervision.ts");

const PILOT: PilotConfig = {
  id: "row-1", pilotId: "ai-doom-private-pilot-1",
  channel: "ai-doom-scroll", channelId: "UCSbJfiA1aobp6G_rgwbHPMw",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: new Date("2026-08-10T21:00:00Z"), completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

/** Times deliberately spread across every rejected corner of the old window. */
const OUTSIDE_THE_OLD_WINDOW = [
  "2026-08-08T16:00:00Z", // Saturday 12:00 EDT — wrong day entirely
  "2026-08-09T06:00:00Z", // Sunday 02:00 EDT — middle of the night
  "2026-08-11T22:00:00Z", // Tuesday 18:00 EDT — right hour, wrong day
  "2026-08-12T13:30:00Z", // Wednesday 09:30 EDT — right day, too early
  "2026-08-12T21:00:00Z", // Wednesday 17:00 EDT — inside the old window
  "2026-08-13T00:00:00Z", // Wednesday 20:00 EDT — the old end-exclusive edge
  "2026-08-13T03:59:00Z", // Wednesday 23:59 EDT — long after it closed
  "2026-12-25T15:00:00Z", // Christmas morning, EST not EDT
];

// ── A. AI Doom manual supervision ────────────────────────────────────────

describe("A. a manually supervised AI Doom pilot may run at any time", () => {
  test("every hour and weekday is allowed once explicitly authorized", () => {
    for (const iso of OUTSIDE_THE_OLD_WINDOW) {
      const d = evaluateAiDoomPilotWindow(new Date(iso), PILOT, MANUAL_SUPERVISED);
      assert.equal(d.allowed, true, `${iso} must be allowed under manual supervision`);
      assert.match(d.reason, /manually supervised/);
    }
  });

  test("the assert form never throws under manual supervision", () => {
    for (const iso of OUTSIDE_THE_OLD_WINDOW) {
      assert.doesNotThrow(
        () => assertAiDoomPilotWindow(new Date(iso), PILOT, MANUAL_SUPERVISED), iso);
    }
  });

  test("it still reports the real local time, so the operator is not misled", () => {
    const d = evaluateAiDoomPilotWindow(
      new Date("2026-08-08T16:00:00Z"), PILOT, MANUAL_SUPERVISED);
    assert.match(d.nowLocal, /Saturday/);
  });

  test("the waiver is not a blanket removal — UNATTENDED still enforces the clock", () => {
    assert.equal(
      evaluateAiDoomPilotWindow(new Date("2026-08-08T16:00:00Z"), PILOT, UNATTENDED).allowed,
      false, "Saturday must still be refused for an unattended run");
    assert.throws(
      () => assertAiDoomPilotWindow(new Date("2026-08-08T16:00:00Z"), PILOT, UNATTENDED),
      (e: unknown) => e instanceof PilotBlockedError && e.code === "PILOT_OUTSIDE_WINDOW");
  });

  test("omitting supervision enforces the window — permission is never inferred", () => {
    // The repository has twice shipped a policy chosen by an ABSENT value. The
    // default here is the restrictive branch on purpose.
    assert.equal(
      evaluateAiDoomPilotWindow(new Date("2026-08-08T16:00:00Z"), PILOT).allowed, false);
    assert.equal(windowApplies(UNATTENDED), true);
    assert.equal(windowApplies(MANUAL_SUPERVISED), false);
    assert.match(SUPERVISION, /UNATTENDED.*DEFAULT|DEFAULT.*UNATTENDED/s);
  });
});

// ── B. Wet Circuit manual supervision ────────────────────────────────────

describe("B. the Wet Circuit canary behaves identically under manual supervision", () => {
  const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;

  test("every hour and weekday is allowed", () => {
    for (const iso of OUTSIDE_THE_OLD_WINDOW) {
      const d = assertWcCanaryWindow(new Date(iso), AUTH, MANUAL_SUPERVISED);
      assert.equal(d.allowed, true, iso);
      assert.match(d.reason, /manually supervised/);
    }
    for (const iso of OUTSIDE_THE_OLD_WINDOW) {
      assert.equal(evaluateWcCanaryWindow(new Date(iso), AUTH, MANUAL_SUPERVISED).allowed, true);
    }
  });

  test("UNATTENDED still refuses outside the authorised window", () => {
    assert.throws(() => assertWcCanaryWindow(new Date("2026-08-08T16:00:00Z"), AUTH, UNATTENDED));
    assert.equal(
      evaluateWcCanaryWindow(new Date("2026-08-08T16:00:00Z"), AUTH, UNATTENDED).allowed, false);
    assert.equal(evaluateWcCanaryWindow(new Date("2026-08-08T16:00:00Z"), AUTH).allowed, false,
      "and the default is still the restrictive branch");
  });

  test("supervision waives the CLOCK, never the configuration checks", () => {
    // A malformed authorisation must still fail closed even when supervised —
    // otherwise claiming supervision would launder a corrupt window.
    const malformed = { ...AUTH, window: { ...AUTH.window, days: [] } };
    assert.throws(
      () => assertWcCanaryWindow(new Date("2026-08-12T21:00:00Z"), malformed, MANUAL_SUPERVISED),
      /window/i);
    const badHours = { ...AUTH, window: { ...AUTH.window, startHour: 20, endHour: 17 } };
    assert.throws(
      () => assertWcCanaryWindow(new Date("2026-08-12T21:00:00Z"), badHours, MANUAL_SUPERVISED));
  });

  test("only the one-shot path declares itself supervised", () => {
    // runWcCanaryOnce is reachable only from wc-canary-control.
    assert.match(WC_PIPELINE, /await pilotGate\(MANUAL_SUPERVISED\)/);
    // The ordinary runner, which a container start CAN reach, does not.
    assert.match(WC_PIPELINE, /const pilot = await pilotGate\(\);/);
    assert.equal((WC_PIPELINE.match(/pilotGate\(MANUAL_SUPERVISED\)/g) ?? []).length, 1,
      "exactly one supervised call site");
  });
});

// ── C. Unattended scheduling is untouched ────────────────────────────────

describe("C. unattended and scheduled production keep every existing restriction", () => {
  test("AI Doom derives supervision from the claimed cycle, not an env var", () => {
    assert.match(AI_PIPELINE, /activeCycle \? UNATTENDED : MANUAL_SUPERVISED/,
      "an unattended run must be identified by its durable cycle");
    assert.ok(!/process\.env\.\w+.*MANUAL_SUPERVISED/.test(AI_PIPELINE),
      "no environment variable may grant the waiver");
  });

  test("the publication cadence is unchanged: Mon/Wed/Fri 15:00 ET", () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const p = publicationPolicyFor(ch);
      assert.deepEqual(p.days, [1, 3, 5]);
      assert.equal(p.hour, 15);
    }
    const slot = nextPublishSlot(new Date("2026-08-12T13:00:00Z"));
    const parts = zonedParts(slot, "America/New_York");
    assert.ok([1, 3, 5].includes(parts.weekday));
    assert.equal(parts.hour, 15);
  });

  test("the scheduler still refuses unless armed with the exact literal", () => {
    assert.equal(SCHEDULER_ENABLED_VALUE, "true");
    for (const v of [undefined, "", "TRUE", "1", "yes", "enabled"]) {
      assert.equal(isSchedulerEnabled({ SCHEDULER_ENABLED: v } as NodeJS.ProcessEnv), false,
        `${String(v)} must not arm the scheduler`);
    }
    assert.equal(isSchedulerEnabled({ SCHEDULER_ENABLED: "true" } as NodeJS.ProcessEnv), true);
  });

  test("a disabled scheduler writes nothing, whatever the hour", () => {
    const writes: string[] = [];
    const deps = {
      now: () => new Date("2026-08-08T16:00:00Z"), // Saturday — supervised pilots may run
      enabled: false,
      currentRunnableCycle: async () => null,
      authorizeCycle: async () => { writes.push("authorize"); return null as never; },
      log: () => {},
    } as unknown as SchedulerDeps;
    return schedulerTick("ai-doom-scroll", deps).then((r) => {
      assert.match(String((r as { outcome?: string }).outcome ?? r), /SKIPPED_DISABLED/);
      assert.equal(writes.length, 0, "the pilot waiver must not leak into the scheduler");
    });
  });

  test("the authorization lead window is unchanged", () => {
    assert.equal(AUTHORIZATION_LEAD_MS, 6 * 60 * 60 * 1000);
    assert.equal(MINIMUM_LEAD_MS, 60 * 60 * 1000);
  });

  test("the shared window primitive itself is untouched", () => {
    // isInWindow still means what it always meant; supervision decides whether
    // it is CONSULTED, and never changes its answer.
    assert.equal(isInWindow(new Date("2026-08-12T21:00:00Z"),
      { days: [1, 3, 5], startHour: 17, endHour: 20, timeZone: "America/New_York" }), true);
    assert.equal(isInWindow(new Date("2026-08-08T16:00:00Z"),
      { days: [1, 3, 5], startHour: 17, endHour: 20, timeZone: "America/New_York" }), false);
  });
});

// ── D. Human review still gates the next video ───────────────────────────

describe("D. the success cap still forces human review between videos", () => {
  const state = (over: Partial<PilotConfig>) => ({
    vars: {
      PILOT_ID: "ai-doom-private-pilot-1", TEST_STAGE: "PRODUCTION",
      PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "true",
    },
    pilot: { ...PILOT, ...over },
    reserved: 0, limits: [], activeRuns: 0, unresolvedIntents: 0,
    now: new Date("2026-08-08T16:00:00Z"), // Saturday: supervision allows running
  });

  test("an exhausted cap is CAP_EXHAUSTED_REVIEW_REQUIRED even on an allowed day", () => {
    assert.equal(
      classifyPhase(state({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] })),
      "CAP_EXHAUSTED_REVIEW_REQUIRED");
  });

  test("a full qualification run still ends in human acceptance", () => {
    assert.equal(
      classifyPhase(state({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] })),
      "QUALIFICATION_COMPLETE_REVIEW_REQUIRED");
  });

  test("advancing the cap still requires the human-review acknowledgement", async () => {
    const deps = {
      readPilot: async () => ({ ...PILOT, successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] }),
      setMaxSuccesses: async () => 1,
      readVars: async () => ({}), setVars: async () => {},
      totalReserved: async () => 0, controlledLimits: async () => [],
      activeRunCount: async () => 0, unresolvedIntentCount: async () => 0,
      runsSince: async () => [], videoById: async () => null,
      now: () => new Date("2026-08-08T16:00:00Z"),
      sleep: async () => {}, log: () => {},
    };
    const r = await doAdvanceCap(deps as never, false);
    assert.equal(r.advanced, false);
    assert.match(r.reason, /--i-have-reviewed-the-previous-video/);
  });

  test("nothing in the supervision change can chain a second video", () => {
    assert.ok(!/MANUAL_SUPERVISED/.test(read("packages/pipeline-core/src/lib/pilot.ts")),
      "the cap logic must not consult supervision at all");
  });
});

// ── E. Spend gates are untouched ─────────────────────────────────────────

describe("E. narration spend and relock protections are unchanged", () => {
  test("RUN still stages DISABLE_ELEVEN, unlocks last, and relocks", () => {
    assert.deepEqual([...RUN_PLAN], [
      "preflight",
      "stage:DISABLE_ELEVEN=false(--skip-deploys)",
      "verify-staged",
      "watermark",
      "unlock:PIPELINE_MODE=production",
      "observe",
      "relock:PIPELINE_MODE=auth_check+DISABLE_ELEVEN=true",
      "verify-relock",
    ]);
    const unlock = RUN_PLAN.indexOf("unlock:PIPELINE_MODE=production");
    const relock = RUN_PLAN.indexOf("relock:PIPELINE_MODE=auth_check+DISABLE_ELEVEN=true");
    assert.ok(unlock < relock, "the relock must follow the unlock");
  });

  test("the per-candidate budget window still opens and relocks exactly", () => {
    const budget = read("packages/pipeline-core/src/lib/budget.ts");
    assert.match(budget, /PRODUCTION: 0/, "production stays locked at 0 by default");
    assert.match(budget, /finally \{\s*await setBudgetLimit\(channel, stage, priorLimit\)/,
      "the window must be restored in a finally, whatever happens");
    assert.ok(!/MANUAL_SUPERVISED|PilotSupervision/.test(budget),
      "supervision must not reach the budget layer at all");
  });

  test("the concept caps are untouched by this change", () => {
    const vf = read("packages/pipeline-core/src/lib/visualFeasibility.ts");
    assert.match(vf, /export const MAX_CONCEPT_SHARE = 0\.4;/);
    const profiles = read("packages/pipeline-core/src/lib/qualityProfile.ts");
    assert.match(profiles, /maxConceptShare: 0\.6/, "WC's authorised profile is unchanged");
    assert.ok(!/MANUAL_SUPERVISED|PilotSupervision/.test(vf + profiles),
      "supervision must not reach the quality gates");
  });

  test("supervision changes no upload policy", () => {
    const pilotLib = read("packages/pipeline-core/src/lib/pilot.ts");
    assert.ok(!/MANUAL_SUPERVISED/.test(pilotLib));
  });
});
