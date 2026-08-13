import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkSupervisedLease, leaseIsLive, canRenew, leasesNeedingRecovery,
  environmentNeedsRelock, SAFE_RESTING_STATE,
  LEASE_MAX_LIFETIME_MS, LEASE_STALE_AFTER_MS, LEASE_HEARTBEAT_MS,
  authorizeNarrationWindow,
} from "@yt-pipeline/pipeline-core";
import type { SupervisedLeaseRow, PilotConfig } from "@yt-pipeline/pipeline-core";
import { RUN_PLAN, foregroundRefusal } from "../scripts/ai-doom-pilot-control";

/**
 * Making process death boring.
 *
 * `ai-doom-pilot-control --run` removed the auth_check lock and relied on its
 * own `finally` to put it back. On 2026-08-13 it was killed in between: Railway
 * stayed at `PIPELINE_MODE=production` with `DISABLE_ELEVEN=false`, and the
 * container bought 5,683 characters of narration with nobody watching.
 *
 * `finally` cannot be the guarantee, because `finally` does not run when a
 * process is killed. So authority became a durable lease that has to be kept
 * alive: stop renewing it and everything downstream refuses.
 *
 * These are the crash transitions. Every one is a state the old design would
 * have accepted.
 */

const T0 = new Date("2026-08-13T12:00:00Z");
const at = (msFromT0: number) => new Date(T0.getTime() + msFromT0);

const LEASE: SupervisedLeaseRow = {
  id: "lease-1",
  channel: "ai-doom-scroll",
  pilotId: "ai-doom-private-pilot-1",
  controllerToken: "token-abc",
  videoId: null,
  runId: null,
  status: "ACTIVE",
  openedAt: T0,
  heartbeatAt: T0,
  expiresAt: new Date(T0.getTime() + LEASE_MAX_LIFETIME_MS),
  closedAt: null,
  closedReason: null,
};

const check = (over: Partial<SupervisedLeaseRow> | null, now: Date, extra = {}) =>
  checkSupervisedLease({
    lease: over === null ? null : { ...LEASE, ...over },
    now, channel: "ai-doom-scroll", ...extra,
  });

// ── The safe resting state ────────────────────────────────────────────────

describe("with no live lease, nothing is authorised", () => {
  test("a missing lease is refused", () => {
    const v = check(null, T0);
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /no supervised lease/);
  });

  test("the safe resting configuration is locked and narration-disabled", () => {
    assert.equal(SAFE_RESTING_STATE.PIPELINE_MODE, "auth_check");
    assert.equal(SAFE_RESTING_STATE.DISABLE_ELEVEN, "true");
  });

  test("a production-capable environment with no lease needs relocking", () => {
    const r = environmentNeedsRelock(
      { PIPELINE_MODE: "production", DISABLE_ELEVEN: "false" }, false);
    assert.equal(r.needed, true);
  });

  test("split-brain states are not silently accepted", () => {
    // Production-capable but narration disabled is still production-capable.
    assert.equal(environmentNeedsRelock(
      { PIPELINE_MODE: "production", DISABLE_ELEVEN: "true" }, false).needed, true);
    // Locked but narration enabled is a staged spend nobody is watching.
    assert.equal(environmentNeedsRelock(
      { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "false" }, false).needed, true);
  });

  test("an already-resting environment needs nothing", () => {
    assert.equal(environmentNeedsRelock(
      { PIPELINE_MODE: "auth_check", DISABLE_ELEVEN: "true" }, false).needed, false);
  });

  test("a live lease justifies the unlocked environment", () => {
    assert.equal(environmentNeedsRelock(
      { PIPELINE_MODE: "production", DISABLE_ELEVEN: "false" }, true).needed, false);
  });
});

// ── Controller death — the transitions the old design missed ─────────────

describe("a controller that stops renewing loses authority", () => {
  test("a freshly renewed lease is live", () => {
    assert.equal(check({ heartbeatAt: at(60_000) }, at(61_000)).live, true);
  });

  test("it survives a few missed beats", () => {
    // One or two slow polls must not be mistaken for death.
    assert.equal(check({}, at(LEASE_HEARTBEAT_MS * 3)).live, true);
  });

  test("it goes stale once renewals stop", () => {
    const v = check({}, at(LEASE_STALE_AFTER_MS + 1000));
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /the controller is gone/);
  });

  test("the hard expiry binds however recently it was renewed", () => {
    const v = check(
      { heartbeatAt: at(LEASE_MAX_LIFETIME_MS + 1000) },
      at(LEASE_MAX_LIFETIME_MS + 1000));
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /expired/);
  });

  test("a closed lease authorises nothing", () => {
    for (const status of ["CLOSED", "EXPIRED"] as const) {
      assert.equal(check({ status }, at(1000)).live, false, status);
    }
  });
});

// ── Renewal cannot become a new authorisation ────────────────────────────

describe("renewal moves the heartbeat and nothing else", () => {
  test("only the owning controller may renew", () => {
    assert.equal(canRenew(LEASE, "token-abc", at(1000)).ok, true);
    const bad = canRenew(LEASE, "someone-else", at(1000));
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /does not match the lease owner/);
  });

  test("a lease past its hard expiry cannot be renewed back to life", () => {
    const r = canRenew(LEASE, "token-abc", at(LEASE_MAX_LIFETIME_MS + 1));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /hard expiry/);
  });

  test("a closed lease cannot be revived", () => {
    assert.equal(canRenew({ ...LEASE, status: "CLOSED" }, "token-abc", at(1000)).ok, false);
  });

  test("the lifetime is bounded, so authority can never be indefinite", () => {
    assert.equal(LEASE_MAX_LIFETIME_MS, 45 * 60 * 1000);
    assert.ok(LEASE_STALE_AFTER_MS < LEASE_MAX_LIFETIME_MS);
    assert.ok(LEASE_HEARTBEAT_MS * 4 <= LEASE_STALE_AFTER_MS,
      "staleness must tolerate several missed beats");
  });
});

// ── Scope: channel, pilot, candidate ─────────────────────────────────────

describe("a lease authorises exactly one scope", () => {
  test("an AI Doom lease cannot authorise Wet Circuit", () => {
    const v = checkSupervisedLease({ lease: LEASE, now: at(1000), channel: "wet-circuit" });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /belongs to ai-doom-scroll/);
  });

  test("a Wet Circuit lease cannot authorise AI Doom", () => {
    const v = checkSupervisedLease({
      lease: { ...LEASE, channel: "wet-circuit" }, now: at(1000), channel: "ai-doom-scroll" });
    assert.equal(v.live, false);
  });

  test("another pilot's lease is refused", () => {
    assert.equal(check({}, at(1000), { pilotId: "some-other-pilot" }).live, false);
  });

  test("a lease bound to one candidate cannot be reused by another", () => {
    assert.equal(check({ videoId: "vid-A" }, at(1000), { videoId: "vid-A" }).live, true);
    assert.equal(check({ videoId: "vid-A" }, at(1000), { videoId: "vid-B" }).live, false);
    // Unbound is still adoptable by the first candidate.
    assert.equal(check({ videoId: null }, at(1000), { videoId: "vid-B" }).live, true);
  });
});

// ── Recovery is independent and idempotent ───────────────────────────────

describe("recovery does not depend on the controller", () => {
  test("it selects exactly the abandoned and expired leases", () => {
    const rows: SupervisedLeaseRow[] = [
      { ...LEASE, id: "fresh", heartbeatAt: at(LEASE_STALE_AFTER_MS - 1000) },
      { ...LEASE, id: "abandoned", heartbeatAt: T0 },
      { ...LEASE, id: "expired", expiresAt: at(-1), heartbeatAt: at(LEASE_STALE_AFTER_MS - 1000) },
      { ...LEASE, id: "already-closed", status: "CLOSED", heartbeatAt: T0 },
    ];
    const got = leasesNeedingRecovery(rows, at(LEASE_STALE_AFTER_MS + 5000))
      .map((r) => r.lease.id).sort();
    assert.deepEqual(got, ["abandoned", "expired"]);
  });

  test("running it twice selects nothing the second time", () => {
    const rows: SupervisedLeaseRow[] = [{ ...LEASE, id: "abandoned", heartbeatAt: T0 }];
    const now = at(LEASE_STALE_AFTER_MS + 5000);
    assert.equal(leasesNeedingRecovery(rows, now).length, 1);
    // After a reconciler closes it, the same input is inert — which is what
    // makes two racing reconcilers safe.
    const closed = rows.map((r) => ({ ...r, status: "EXPIRED" as const }));
    assert.equal(leasesNeedingRecovery(closed, now).length, 0);
  });

  test("a lease still being renewed is never recovered out from under its run", () => {
    const rows = [{ ...LEASE, heartbeatAt: at(60_000) }];
    assert.equal(leasesNeedingRecovery(rows, at(61_000)).length, 0);
  });
});

// ── Spend refuses once supervision lapses ────────────────────────────────

describe("the spend path re-checks supervision", () => {
  const PILOT: PilotConfig = {
    id: "row-1", pilotId: "ai-doom-private-pilot-1",
    channel: "ai-doom-scroll", channelId: "UC", status: "ACTIVE",
    maxSuccesses: 1, successCount: 0, successVideoIds: [],
    activatedAt: T0, completedAt: null, privacyStatus: "private",
    allowPublishAt: false, shortsEnabled: false,
    requireFeasibility: true, requireGuardedUpload: true,
    windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
    timezone: "America/New_York",
  };
  const ask = (over = {}) => authorizeNarrationWindow({
    channel: "ai-doom-scroll", stage: "PRODUCTION" as never, pilot: PILOT,
    submitChars: 5000, unattended: false, elevenDisabled: false,
    supervised: true, ...over,
  });

  test("an expired lease cannot authorise spend", () => {
    const d = ask({ supervised: false, supervisionReason: "lease expired" });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /no live supervised lease/);
  });

  test("DISABLE_ELEVEN still outranks a perfectly live lease", () => {
    assert.equal(ask({ elevenDisabled: true, supervised: true }).open, false);
  });

  test("a live lease plus a valid pilot still opens", () => {
    assert.equal(ask().open, true);
  });

  test("supervision does not rescue an otherwise unauthorised run", () => {
    assert.equal(ask({ pilot: null }).open, false);
    assert.equal(ask({ unattended: true }).open, false);
  });
});

// ── Controller and pipeline wiring ───────────────────────────────────────

describe("the controller opens before unlocking and closes after relocking", () => {
  test("the lease is opened before any variable is staged", () => {
    const plan = [...RUN_PLAN];
    assert.ok(plan.indexOf("lease:open") < plan.indexOf("stage:DISABLE_ELEVEN=false(--skip-deploys)"),
      "there must be no moment of capability without a durable record");
    assert.ok(plan.indexOf("lease:open") < plan.indexOf("unlock:PIPELINE_MODE=production"));
  });

  test("the lease is closed as part of the relock path", () => {
    const plan = [...RUN_PLAN];
    assert.ok(plan.indexOf("lease:close") > plan.indexOf("relock:PIPELINE_MODE=auth_check+DISABLE_ELEVEN=true"));
  });

  test("the pipeline refuses a pilot candidate with no live lease", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    assert.match(src, /verifySupervision\(/);
    assert.match(src, /refusing to run a pilot candidate/);
    // Startup reconciliation, so a restart into a stale environment closes the
    // abandoned lease rather than inheriting it.
    assert.match(src, /await reconcileLeases\(\)/);
  });

  test("the voiceover stage re-checks supervision at spend time", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.match(src, /verifySupervision\(/);
    assert.match(src, /supervised: supervision\.live/);
  });

  test("the reconciler never starts, spends, or touches a candidate", () => {
    const src = readFileSync("scripts/reconcile-supervision.ts", "utf8");
    for (const forbidden of ["runPipeline", "voiceover", "setBudgetLimit", "video.update"]) {
      assert.ok(!src.includes(forbidden), `reconciler must not reference ${forbidden}`);
    }
  });
});

describe("a spend-authorising run must be supervised in the foreground", () => {
  test("a detached --run is refused", () => {
    const r = foregroundRefusal(["node", "x", "--run", "--i-understand-this-spends-credits"], false);
    assert.ok(r);
    assert.match(r!, /foreground/);
  });

  test("an attached --run is allowed", () => {
    assert.equal(foregroundRefusal(["node", "x", "--run"], true), null);
  });

  test("read-only modes are unaffected", () => {
    assert.equal(foregroundRefusal(["node", "x"], false), null);
    assert.equal(foregroundRefusal(["node", "x", "--relock"], false), null);
  });

  test("CI may opt in explicitly, never silently", () => {
    assert.equal(
      foregroundRefusal(["node", "x", "--run", "--i-am-running-in-the-foreground"], false), null);
  });
});

// ── Wet Circuit is untouched ─────────────────────────────────────────────

describe("Wet Circuit behaviour is unchanged", () => {
  test("its voiceover does not consult the lease", () => {
    const wc = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
    assert.ok(!/verifySupervision|supervisedLease/.test(wc));
    assert.match(wc, /withBudgetWindow\("wet-circuit", testStage, submitChars,/);
  });

  test("its pipeline does not gate on the lease", () => {
    const wc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.ok(!/verifySupervision/.test(wc));
  });
});
