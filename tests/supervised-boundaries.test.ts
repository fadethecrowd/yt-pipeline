import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkSupervisedLease, LEASE_STALE_AFTER_MS, LEASE_MAX_LIFETIME_MS,
} from "@yt-pipeline/pipeline-core";
import type { SupervisedLeaseRow } from "@yt-pipeline/pipeline-core";

/**
 * Entry authorisation is not a licence for the rest of the run.
 *
 * The lease is checked at the pilot gate and again when narration is bought.
 * Neither runs again afterwards: one container executes the whole pipeline, so
 * a controller that dies AFTER narration leaves a process with momentum —
 * no restart, no second entry, no second purchase, and previously nothing
 * asking whether anyone was still watching before it rendered and uploaded.
 *
 * That is the 2026-08-13 failure one stage later. The only reason it stopped
 * short of an upload last time is that an unrelated redeploy killed it.
 *
 * So authority is re-asked immediately before the two irreversible actions.
 * These tests are the state machine of that refusal.
 */

const SRC = readFileSync("src/pipeline.ts", "utf8");
const T0 = new Date("2026-08-13T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const LEASE: SupervisedLeaseRow = {
  id: "lease-1", channel: "ai-doom-scroll", pilotId: "ai-doom-private-pilot-1",
  controllerToken: "tok", videoId: "vid-A", runId: "run-A", status: "ACTIVE",
  openedAt: T0, heartbeatAt: T0,
  expiresAt: new Date(T0.getTime() + LEASE_MAX_LIFETIME_MS),
  closedAt: null, closedReason: null,
};

/** Exactly what a boundary asks: the canonical verifier, same scope fields. */
const boundary = (over: Partial<SupervisedLeaseRow> | null, now: Date, scope = {}) =>
  checkSupervisedLease({
    lease: over === null ? null : { ...LEASE, ...over },
    now, channel: "ai-doom-scroll", pilotId: "ai-doom-private-pilot-1",
    videoId: "vid-A", ...scope,
  });

// ── The boundaries exist and sit in the right places ─────────────────────

describe("the two irreversible boundaries are guarded", () => {
  test("render is guarded, and the guard runs before assembly", () => {
    assert.match(SRC, /async function guardedVideoAssembly/);
    assert.match(SRC, /{ name: "videoAssembly", execute: guardedVideoAssembly/);
    const g = SRC.indexOf("async function guardedVideoAssembly");
    const body = SRC.slice(g, g + 400);
    assert.ok(body.indexOf("assertSupervisedBoundary") < body.indexOf("videoAssemblyStage(ctx)"),
      "supervision must be checked before the render starts");
  });

  test("upload is guarded before the intent and the insert", () => {
    const u = SRC.indexOf("async function guardedYoutubeUpload");
    const body = SRC.slice(u, u + 1200);
    assert.ok(body.includes("assertSupervisedBoundary(ctx, \"youtubeUpload\")"));
    // guardedUpload creates the intent and calls videos.insert in one
    // synchronous call, so a single boundary covers both.
    assert.ok(body.indexOf("assertSupervisedBoundary") < body.indexOf("assertFinalQaPassed"),
      "supervision is asked before any upload work, including the QA read");
  });

  test("the checks are narrow — only these two boundaries", () => {
    assert.equal((SRC.match(/assertSupervisedBoundary\(/g) ?? []).length, 3,
      "one definition plus exactly two call sites");
  });
});

// ── Refusal, at both boundaries, for every invalid lease state ───────────

describe("a boundary refuses whenever supervision is not live", () => {
  const cases: [string, ReturnType<typeof boundary>][] = [
    ["missing lease", boundary(null, at(1000))],
    ["stale heartbeat", boundary({}, at(LEASE_STALE_AFTER_MS + 1000))],
    ["hard-expired", boundary({ expiresAt: at(-1) }, at(1000))],
    ["closed lease", boundary({ status: "CLOSED" }, at(1000))],
    ["reconciled lease", boundary({ status: "EXPIRED" }, at(1000))],
    ["wrong channel", checkSupervisedLease({
      lease: LEASE, now: at(1000), channel: "wet-circuit" })],
    ["wrong pilot", boundary({}, at(1000), { pilotId: "other-pilot" })],
    ["wrong candidate", boundary({}, at(1000), { videoId: "vid-B" })],
  ];

  for (const [name, verdict] of cases) {
    test(`${name} is refused`, () => {
      assert.equal(verdict.live, false, name);
      assert.ok((verdict as { reason: string }).reason.length > 0);
    });
  }

  test("a live, correctly scoped lease permits the boundary", () => {
    assert.equal(boundary({ heartbeatAt: at(60_000) }, at(61_000)).live, true);
  });
});

// ── The pipeline must never keep itself alive ────────────────────────────

describe("the pipeline may refuse but never renew", () => {
  test("the boundary helper only reads supervision", () => {
    const h = SRC.indexOf("async function assertSupervisedBoundary");
    const body = SRC.slice(h, SRC.indexOf("async function guardedVideoAssembly"));
    assert.match(body, /verifySupervision\(/);
    for (const forbidden of ["renewLease", "openLease", "bindLease", "closeLease"]) {
      assert.ok(!body.includes(forbidden),
        `the pipeline must not call ${forbidden} — heartbeat is the controller's evidence of life`);
    }
  });

  test("no pipeline stage renews the lease anywhere", () => {
    assert.ok(!/renewLease/.test(SRC), "src/pipeline.ts must never renew supervision");
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.ok(!/renewLease/.test(vo), "the spend path must never renew supervision");
  });

  test("only the controller renews", () => {
    const ctl = readFileSync("scripts/ai-doom-pilot-control.ts", "utf8");
    assert.match(ctl, /leaseRenew/);
  });
});

// ── Scope: this protects the pilot path, not all production forever ──────

describe("the requirement is scoped to supervised pilot execution", () => {
  test("unattended cycles and ordinary production are unaffected", () => {
    const h = SRC.indexOf("async function assertSupervisedBoundary");
    const body = SRC.slice(h, SRC.indexOf("async function guardedVideoAssembly"));
    assert.match(body, /if \(activeCycle\) return null;/);
    assert.match(body, /if \(!pilot\) return null;/);
  });

  test("Wet Circuit is untouched by these boundaries", () => {
    const wc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.ok(!/assertSupervisedBoundary|verifySupervision/.test(wc));
  });
});

// ── The precise hazard, simulated end to end ─────────────────────────────

describe("controller death after narration stops the run before it can do harm", () => {
  /**
   * Replays the exact sequence, deterministically: authority is real at entry
   * and at purchase, then the controller dies and the SAME execution continues.
   */
  test("valid at entry and narration, refused at render and upload", () => {
    let lease: SupervisedLeaseRow = { ...LEASE };
    const ask = (now: Date) => checkSupervisedLease({
      lease, now, channel: "ai-doom-scroll",
      pilotId: "ai-doom-private-pilot-1", videoId: "vid-A",
    });

    // 1-3. entry and narration, while the controller is renewing normally.
    assert.equal(ask(at(0)).live, true, "pilot gate");
    lease = { ...lease, heartbeatAt: at(30_000) };
    assert.equal(ask(at(35_000)).live, true, "narration purchase");

    // 4. the controller dies here. Nothing renews from now on.
    const deathAt = 35_000;

    // 5-6. the same process continues; the next boundaries refuse.
    const atRender = at(deathAt + LEASE_STALE_AFTER_MS + 5_000);
    const render = ask(atRender);
    assert.equal(render.live, false, "render must refuse");
    assert.match((render as { reason: string }).reason, /the controller is gone/);

    const upload = ask(at(deathAt + LEASE_STALE_AFTER_MS + 120_000));
    assert.equal(upload.live, false, "upload must refuse");
  });

  test("a lease that survives render but dies before upload still refuses", () => {
    const lease = { ...LEASE, heartbeatAt: at(200_000) };
    const ask = (now: Date) => checkSupervisedLease({
      lease, now, channel: "ai-doom-scroll",
      pilotId: "ai-doom-private-pilot-1", videoId: "vid-A" });
    assert.equal(ask(at(210_000)).live, true, "render allowed");
    assert.equal(ask(at(200_000 + LEASE_STALE_AFTER_MS + 1_000)).live, false, "upload refused");
  });

  test("refusal is a stage failure, so the candidate lands non-resumable", () => {
    // A stage returning success:false is routed to failVideo, which sets
    // FAILED — the quarantine status, deliberately absent from RESUME_FROM.
    // That is what stops a later run resuming against narration that lived
    // only on the dead container's disk.
    assert.match(SRC, /return \{ success: false, error, durationMs: 0 \}/);
    assert.match(SRC, /await failVideo\(ctx, stage\.name, result\.error \?\? "unknown error"\)/);
    assert.match(SRC, /status: VideoStatus\.FAILED/);
    const resumable = SRC.slice(SRC.indexOf("const RESUME_FROM"), SRC.indexOf("/** Fails closed"));
    assert.ok(!resumable.includes("FAILED"), "FAILED must never be a resume point");
  });

  test("the failure path buys nothing, uploads nothing, advances nothing", () => {
    const h = SRC.indexOf("async function assertSupervisedBoundary");
    const body = SRC.slice(h, SRC.indexOf("/** Render is the first"));
    for (const forbidden of ["voiceover(", "guardedUpload", "setBudgetLimit", "successCount"]) {
      assert.ok(!body.includes(forbidden), `the refusal must not touch ${forbidden}`);
    }
  });
});
