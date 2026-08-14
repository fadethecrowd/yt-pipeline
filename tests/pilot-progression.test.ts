import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assertRunnable, PilotBlockedError } from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import { classifyPhase, gatherState, MAX_CAP, doAdvanceCap } from "../scripts/ai-doom-pilot-control";
import type { ControlDeps } from "../scripts/ai-doom-pilot-control";
import { SPECS, evaluate, doCheck, doComplete } from "../scripts/channel-graduation-control";
import type { GradDeps, VideoRow, QaRow } from "../scripts/channel-graduation-control";

/**
 * Progressive pilot authorisation, and the defect that made it unreachable.
 *
 * `confirmPilotSlot` used to mark the pilot COMPLETED the moment
 * `successVideoIds` reached `maxSuccesses`. That conflated two different
 * things: the CURRENT AUTHORISATION CEILING, and a human having reviewed and
 * accepted the qualification. For AI Doom — 0/1 → review → 1/2 → review → 2/3 —
 * a pilot at 1/1 has only spent its ceiling. Auto-completing there made it
 * non-ACTIVE, which both `assertRunnable` and the cap-advance control refuse, so
 * video #2 could never happen and the review gate could never be crossed.
 *
 * A private upload reaching YouTube is evidence the machinery worked, not that
 * a person watched it. Completion is now explicit for both channels.
 */

const PILOT_SRC = readFileSync("packages/pipeline-core/src/lib/pilot.ts", "utf8");
const AI_CTRL = readFileSync("scripts/ai-doom-pilot-control.ts", "utf8");
const WC_CTRL = readFileSync("scripts/wc-canary-control.ts", "utf8");
const GRAD = readFileSync("scripts/channel-graduation-control.ts", "utf8");

const SHA = "a".repeat(64);
const MON = new Date("2026-08-10T22:00:00Z");

const pilot = (over: Partial<PilotConfig> = {}): PilotConfig => ({
  id: "row", pilotId: "ai-doom-private-pilot-1", channel: "ai-doom-scroll", channelId: "UC",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: new Date("2026-08-10T21:00:00Z"), completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York", ...over,
});

const remaining = (p: PilotConfig) => Math.max(0, p.maxSuccesses - p.successCount);
const codeOf = (fn: () => unknown): string => {
  try { fn(); return "NO_THROW"; }
  catch (e) { return e instanceof PilotBlockedError ? e.code : "OTHER"; }
};

// ── 1-12. The defect itself ──────────────────────────────────────────────

describe("confirmPilotSlot no longer completes the pilot", () => {
  test("1/7. it appends the success id and nothing else", () => {
    const fn = PILOT_SRC.slice(
      PILOT_SRC.indexOf("export async function confirmPilotSlot"),
      PILOT_SRC.indexOf("export async function completePilot"),
    );
    assert.match(fn, /array_append\("successVideoIds", \$2\)/);
    assert.ok(!fn.includes("'COMPLETED'"), "must not mark COMPLETED");
    assert.ok(!fn.includes("completedAt"), "must not write completedAt");
  });

  test("12. the append stays idempotent", () => {
    const fn = PILOT_SRC.slice(PILOT_SRC.indexOf("export async function confirmPilotSlot"));
    assert.match(fn, /NOT \(\$2 = ANY\("successVideoIds"\)\)/);
  });

  test("completion is now a separate guarded operation", () => {
    assert.match(PILOT_SRC, /export async function completePilot\(/);
    const fn = PILOT_SRC.slice(PILOT_SRC.indexOf("export async function completePilot"));
    assert.match(fn, /SET "status" = 'COMPLETED', "completedAt" = NOW\(\)/);
    assert.match(fn, /AND "status" = 'ACTIVE'/);
    assert.match(fn, /AND "successCount" = \$2/);
    assert.match(fn, /AND "maxSuccesses" = \$2/);
    assert.match(fn, /array_length\("successVideoIds", 1\), 0\) = \$2/);
  });

  test("2. a consumed ceiling still blocks the next run", () => {
    const p = pilot({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] });
    assert.equal(remaining(p), 0);
    assert.equal(codeOf(() => assertRunnable(p)), "PILOT_CAP_REACHED");
  });

  test("the pilot stays ACTIVE at every intermediate ceiling", () => {
    for (const [c, m] of [[1, 1], [2, 2]] as const) {
      const p = pilot({ successCount: c, maxSuccesses: m });
      assert.equal(p.status, "ACTIVE");
      assert.equal(remaining(p), 0);
    }
  });

  test("8. a fourth run is impossible at the qualification target", () => {
    const p = pilot({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] });
    assert.equal(remaining(p), 0);
    assert.equal(codeOf(() => assertRunnable(p)), "PILOT_CAP_REACHED");
  });
});

// ── Phase classification through the progression ─────────────────────────

function fakeCtrl(p: PilotConfig): ControlDeps {
  return {
    async readVars() {
      return { PILOT_ID: "ai-doom-private-pilot-1", PIPELINE_MODE: "auth_check",
        TEST_STAGE: "PRODUCTION", DISABLE_ELEVEN: "true" };
    },
    async setVars() { throw new Error("must not mutate Railway"); },
    async readPilot() { return { ...p }; },
    async activatePilot() { return 1; },
    async setMaxSuccesses() { return 1; },
    async totalReserved() { return 0; },
    async controlledLimits() { return [{ key: "ai-doom-scroll/PRODUCTION", limit: 0 }]; },
    async activeRunCount() { return 0; },
    async unresolvedIntentCount() { return 0; },
    async runsSince() { return []; },
    async videoById(id) { return { id, youtubeId: "y", status: "UPLOADED", scheduledAt: null }; },
    now: () => MON,
    async sleep() {},
    log: () => {},
  };
}
const phaseOf = async (p: PilotConfig) => classifyPhase(await gatherState(fakeCtrl(p)));

describe("3-9. the full AI Doom progression", () => {
  test("1/1 is CAP_EXHAUSTED_REVIEW_REQUIRED, not complete", async () => {
    assert.equal(await phaseOf(pilot({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] })),
      "CAP_EXHAUSTED_REVIEW_REQUIRED");
  });

  test("3/4. advancing 1→2 needs the review acknowledgement, then arms one slot", async () => {
    const p = pilot({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] });
    assert.equal((await doAdvanceCap(fakeCtrl(p), false)).advanced, false);
    const r = await doAdvanceCap(fakeCtrl(p), true);
    assert.equal(r.advanced, true);
    assert.deepEqual([r.from, r.to], [1, 2]);
    assert.equal(await phaseOf(pilot({ successCount: 1, maxSuccesses: 2, successVideoIds: ["v1"] })),
      "ARMED_FOR_RUN");
  });

  test("5/6. 2/2 exhausts again, and 2→3 advances", async () => {
    const p = pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["v1", "v2"] });
    assert.equal(await phaseOf(p), "CAP_EXHAUSTED_REVIEW_REQUIRED");
    const r = await doAdvanceCap(fakeCtrl(p), true);
    assert.deepEqual([r.advanced, r.from, r.to], [true, 2, 3]);
  });

  test("7. 3/3 reports qualification complete, awaiting human acceptance", async () => {
    assert.equal(
      await phaseOf(pilot({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] })),
      "QUALIFICATION_COMPLETE_REVIEW_REQUIRED");
  });

  test("the cap can never advance past the qualification target", async () => {
    const p = pilot({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] });
    const r = await doAdvanceCap(fakeCtrl(p), true);
    assert.equal(r.advanced, false);
    assert.match(r.reason, /qualification target/);
    assert.equal(MAX_CAP, 3);
  });

  test("the control never marks a pilot COMPLETED itself", () => {
    assert.ok(!AI_CTRL.includes("'COMPLETED'"));
    assert.ok(!AI_CTRL.includes('"COMPLETED", "completedAt"'));
  });
});

// ── Graduation control ───────────────────────────────────────────────────

const vrow = (id: string, over: Partial<VideoRow> = {}): VideoRow => ({
  id, youtubeId: `yt-${id}`, status: "UPLOADED", scheduledAt: null, videoPath: null, ...over,
});
const qrow = (over: Partial<QaRow> = {}): QaRow => ({
  id: "qa", overall: "PASS", createdAt: new Date("2026-08-10T23:00:00Z"),
  checks: [{ name: "final_video_sha256", passed: true, severity: "FATAL", detail: "b", value: SHA }],
  ...over,
});

interface GFake { deps: GradDeps; completes: number[] }
function gfake(p: PilotConfig | null, o: {
  rows?: Record<string, VideoRow | null>; qa?: QaRow[]; unresolved?: number;
  reserved?: number; limits?: { key: string; limit: number }[]; active?: number;
  vars?: Record<string, string>; completeRows?: number; sha?: string | null;
} = {}): GFake {
  const completes: number[] = [];
  const deps: GradDeps = {
    async readPilot() { return p ? { ...p } : null; },
    async readRow(_m, id) { return o.rows ? (o.rows[id] ?? null) : vrow(id); },
    async readQa() { return o.qa ?? [qrow()]; },
    async fileSha256() { return o.sha === undefined ? null : o.sha; },
    async unresolvedIntentCount() { return o.unresolved ?? 0; },
    async totalReserved() { return o.reserved ?? 0; },
    async controlledLimits() { return o.limits ?? [{ key: "c/PRODUCTION", limit: 0 }]; },
    async activeRunCount() { return o.active ?? 0; },
    async readVars() { return o.vars ?? { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "true" }; },
    async complete(_id, exp) { completes.push(exp); return o.completeRows ?? 1; },
    log: () => {},
  };
  return { deps, completes };
}

describe("21-28. graduation completion", () => {
  const AI = SPECS["ai-doom-scroll"];
  const WC = SPECS["wet-circuit"];

  test("21. AI Doom refuses completion below its qualification target", async () => {
    const f = gfake(pilot({ successCount: 1, maxSuccesses: 1, successVideoIds: ["v1"] }));
    const r = await evaluate(f.deps, AI);
    assert.equal(r.phase, "CAP_EXHAUSTED_REVIEW_REQUIRED");
    assert.equal((await doComplete(f.deps, AI, true)).completed, false);
    assert.equal(f.completes.length, 0);
  });

  /**
   * The target is two because a human decided two was enough evidence, on
   * 2026-08-14, having watched both. Lowering it from three is what CLOSES the
   * pilot: at 2/2 ACTIVE the cap-advance control could still have authorised a
   * third run. Every per-video evidentiary check below is unchanged.
   */
  test("22. the AI Doom qualification target is two reviewed videos", () => {
    assert.equal(AI.qualificationTarget, 2);
  });

  test("23. AI Doom 2/2 with two valid reviewed outputs completes with one CAS", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }));
    assert.equal((await evaluate(f.deps, AI)).phase, "READY_TO_COMPLETE");
    const r = await doComplete(f.deps, AI, true);
    assert.equal(r.completed, true);
    assert.deepEqual(f.completes, [2], "the CAS must assert the target, not a stale 3");
  });

  test("a pilot beyond the target is not silently accepted", async () => {
    // 3/3 no longer matches a target of 2; the confirmed-count check refuses
    // rather than completing against the wrong number.
    const f = gfake(pilot({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] }));
    assert.notEqual((await evaluate(f.deps, AI)).phase, "READY_TO_COMPLETE");
    assert.equal((await doComplete(f.deps, AI, true)).completed, false);
  });

  test("completion without the acknowledgement mutates nothing", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }));
    assert.equal((await doComplete(f.deps, AI, false)).completed, false);
    assert.equal(f.completes.length, 0);
  });

  test("24. a failed QA verdict refuses", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { qa: [qrow({ overall: "FAIL" })] });
    assert.notEqual((await evaluate(f.deps, AI)).phase, "READY_TO_COMPLETE");
    assert.equal((await doComplete(f.deps, AI, true)).completed, false);
  });

  test("a missing success row or missing youtubeId refuses", async () => {
    const missing = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { rows: { a: vrow("a"), b: null } });
    assert.notEqual((await evaluate(missing.deps, AI)).phase, "READY_TO_COMPLETE");
    const noYt = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { rows: { a: vrow("a"), b: vrow("b", { youtubeId: null }) } });
    assert.notEqual((await evaluate(noYt.deps, AI)).phase, "READY_TO_COMPLETE");
  });

  test("a scheduled (non-private) success refuses", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { rows: { a: vrow("a"), b: vrow("b", { scheduledAt: new Date() }) } });
    assert.notEqual((await evaluate(f.deps, AI)).phase, "READY_TO_COMPLETE");
  });

  test("25/26. unresolved intent and active run refuse", async () => {
    const full = { successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] };
    assert.equal((await evaluate(gfake(pilot(full), { unresolved: 1 }).deps, AI)).phase,
      "RECONCILIATION_REQUIRED");
    assert.notEqual((await evaluate(gfake(pilot(full), { active: 1 }).deps, AI)).phase,
      "READY_TO_COMPLETE");
  });

  test("nonzero reservation or open budget refuses", async () => {
    const full = { successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] };
    assert.notEqual((await evaluate(gfake(pilot(full), { reserved: 400 }).deps, AI)).phase, "READY_TO_COMPLETE");
    assert.notEqual((await evaluate(gfake(pilot(full),
      { limits: [{ key: "c/PRODUCTION", limit: 4000 }] }).deps, AI)).phase, "READY_TO_COMPLETE");
  });

  test("an unlocked service refuses", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { vars: { PIPELINE_MODE: "production", DISABLE_ELEVEN: "true" } });
    assert.notEqual((await evaluate(f.deps, AI)).phase, "READY_TO_COMPLETE");
  });

  test("11/27. a CAS matching zero rows refuses", async () => {
    const f = gfake(pilot({ successCount: 2, maxSuccesses: 2, successVideoIds: ["a", "b"] }),
      { completeRows: 0 });
    const r = await doComplete(f.deps, AI, true);
    assert.equal(r.completed, false);
    assert.match(r.reason, /matched 0 rows/);
  });

  test("9/13/14. WC refuses at 0/1 and completes at a reviewed 1/1", async () => {
    const wcP = (over: Partial<PilotConfig>) => pilot({
      pilotId: "wet-circuit-private-canary-1", channel: "wet-circuit", ...over });
    const zero = gfake(wcP({ successCount: 0, maxSuccesses: 1 }));
    assert.notEqual((await evaluate(zero.deps, WC)).phase, "READY_TO_COMPLETE");
    assert.equal((await doComplete(zero.deps, WC, true)).completed, false);

    const one = gfake(wcP({ successCount: 1, maxSuccesses: 1, successVideoIds: ["c1"] }));
    assert.equal((await evaluate(one.deps, WC)).phase, "READY_TO_COMPLETE");
    const r = await doComplete(one.deps, WC, true);
    assert.equal(r.completed, true);
    assert.deepEqual(one.completes, [1]);
  });

  test("15/17. an already COMPLETED pilot reports COMPLETED and completes no further", async () => {
    const f = gfake(pilot({ status: "COMPLETED", successCount: 3, maxSuccesses: 3,
      successVideoIds: ["a", "b", "c"], completedAt: new Date() }));
    assert.equal((await evaluate(f.deps, SPECS["ai-doom-scroll"])).phase, "COMPLETED");
    assert.equal((await doComplete(f.deps, SPECS["ai-doom-scroll"], true)).completed, false);
  });

  test("a PREPARED pilot is NOT_ACTIVATED, never completable", async () => {
    const f = gfake(pilot({ status: "PREPARED", activatedAt: null }));
    assert.equal((await evaluate(f.deps, SPECS["ai-doom-scroll"])).phase, "NOT_ACTIVATED");
    assert.equal((await doComplete(f.deps, SPECS["ai-doom-scroll"], true)).completed, false);
  });

  test("28. completion changes only status/completedAt/updatedAt", () => {
    const fn = PILOT_SRC.slice(PILOT_SRC.indexOf("export async function completePilot"));
    const setClause = fn.slice(fn.indexOf("SET"), fn.indexOf("WHERE"));
    for (const forbidden of ["successCount", "maxSuccesses", "successVideoIds",
                             "privacyStatus", "windowDays", "shortsEnabled"]) {
      assert.ok(!setClause.includes(forbidden), `completion must not write ${forbidden}`);
    }
  });

  test("CHECK is read-only and never asserts approval", async () => {
    const f = gfake(pilot({ successCount: 3, maxSuccesses: 3, successVideoIds: ["a", "b", "c"] }));
    await doCheck(f.deps, SPECS["ai-doom-scroll"]);
    assert.equal(f.completes.length, 0);
    assert.match(GRAD, /human approval : NOT YET ASSERTED/);
  });
});

// ── 18-20. Shared invariants and isolation ───────────────────────────────

describe("18-20. shared invariants", () => {
  test("qualification targets are explicit per channel", () => {
    // AI Doom's target moved 3 → 2 on 2026-08-14 when the human accepted
    // KD2QDUsr0HA as the second and final qualification video.
    assert.equal(SPECS["ai-doom-scroll"].qualificationTarget, 2);
    assert.equal(SPECS["wet-circuit"].qualificationTarget, 1);
    assert.equal(SPECS["ai-doom-scroll"].model, "video");
    assert.equal(SPECS["wet-circuit"].model, "wcVideo");
  });

  test("19. the ceiling can never be overflowed", () => {
    const claim = PILOT_SRC.slice(PILOT_SRC.indexOf("export async function claimPilotSlot"));
    assert.match(claim, /AND "successCount" < "maxSuccesses"/);
    assert.match(claim, /AND "status" = 'ACTIVE'/);
  });

  test("20. ordinary non-pilot behaviour is untouched", () => {
    assert.match(PILOT_SRC, /if \(!pilot\) \{[\s\S]{0,200}scheduledSlot: normalSlot/);
  });

  test("WC canary control reports the post-success review state", () => {
    assert.match(WC_CTRL, /CANARY_COMPLETE_REVIEW_REQUIRED/);
  });

  test("the graduation control never runs a pipeline or touches Railway state", () => {
    for (const t of ["runPipeline", "setVars", "variables set", "videos.update", "PIPELINE_MODE="]) {
      assert.ok(!GRAD.includes(t), `graduation control must not reference ${t}`);
    }
  });

  test("no runtime imports the graduation control", () => {
    for (const f of ["src/index.ts", "src/pipeline.ts",
                     "packages/wc-pipeline/src/pipeline.ts", "packages/pipeline-core/src/index.ts"]) {
      assert.ok(!readFileSync(f, "utf8").includes("channel-graduation-control"), f);
    }
  });

  test("importing the graduation control runs nothing", () => {
    assert.match(GRAD, /const isDirectRun =/);
    assert.match(GRAD, /if \(isDirectRun\) \{/);
  });
});
