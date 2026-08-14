import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canBind, checkSupervisedLease,
  LEASE_MAX_LIFETIME_MS, LEASE_STALE_AFTER_MS,
} from "@yt-pipeline/pipeline-core";
import type { SupervisedLeaseRow, BindRequest } from "@yt-pipeline/pipeline-core";

/**
 * The lease that supervised qualification video #1 was never actually scoped.
 *
 * Lease `cmst0nbzw0000mb3brsuaruom` was opened before the unlock, heartbeated
 * for roughly twenty minutes, never went stale, never hit hard expiry, and was
 * closed cleanly after the relock. Supervision worked. What did not work is
 * that `bindLease` — which exists, and whose whole purpose is to pin a lease to
 * one execution — was never called from anywhere. `videoId` and `runId` stayed
 * null for the lease's entire life.
 *
 * The consequence is not theoretical. `checkSupervisedLease` treats a null
 * `videoId` as "matches anything", so every boundary that believed it was
 * asking "is THIS candidate supervised?" was really only asking "is this
 * channel supervised?". Any candidate, and any number of them, would have
 * satisfied that lease. The 1/1 pilot cap was the only thing standing between
 * that lease and a second video.
 *
 * There was also no run identity to bind even if someone had called it:
 * `pipeline_run` was created by `RunSummary.persist()` at the END of the run,
 * so during the run there was no run id in existence. `RunSummary` now mints
 * its id at construction and persists that same id, which is what makes
 * candidate and run bindable together before any spend.
 */

const CHANNEL = "ai-doom-scroll" as const;
const PILOT = "ai-doom-private-pilot-1";
const TOKEN = "controller-token-A";
const VIDEO = "cmst0qf8i0004qm0e6gi1wwyv";   // qualification #1's real candidate
const RUN = "run-A";

const T0 = new Date("2026-08-14T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function lease(over: Partial<SupervisedLeaseRow> = {}): SupervisedLeaseRow {
  return {
    id: "lease-1",
    channel: CHANNEL,
    pilotId: PILOT,
    controllerToken: TOKEN,
    videoId: null,
    runId: null,
    status: "ACTIVE",
    openedAt: T0,
    heartbeatAt: T0,
    expiresAt: new Date(T0.getTime() + LEASE_MAX_LIFETIME_MS),
    closedAt: null,
    closedReason: null,
    ...over,
  };
}

const req = (over: Partial<BindRequest> = {}): BindRequest => ({
  channel: CHANNEL, pilotId: PILOT, videoId: VIDEO, runId: RUN, ...over,
});

// ── A fresh lease is deliberately unbound ────────────────────────────────

describe("a lease starts as a channel/pilot authorization", () => {
  test("a newly opened lease names no candidate and no run", () => {
    const l = lease();
    assert.equal(l.videoId, null);
    assert.equal(l.runId, null);
  });

  test("that is legitimate before an execution exists", () => {
    // The startup gate runs before any candidate is created, so it must accept
    // an unbound lease — there is nothing yet to bind.
    const v = checkSupervisedLease({ lease: lease(), now: at(1000), channel: CHANNEL, pilotId: PILOT });
    assert.equal(v.live, true);
  });

  test("but an unbound lease authorises no specific candidate", () => {
    // The exact defect: without requireBound, ANY candidate satisfies it.
    for (const videoId of ["candidate-A", "candidate-B", "candidate-C"]) {
      const v = checkSupervisedLease({
        lease: lease(), now: at(1000), channel: CHANNEL, pilotId: PILOT, videoId,
      });
      assert.equal(v.live, true, `${videoId} was accepted by an unbound lease`);
    }
  });
});

// ── Binding: the happy path ──────────────────────────────────────────────

describe("binding pins the lease to one execution", () => {
  test("an unbound, live lease accepts a bind", () => {
    const v = canBind(lease(), req(), at(1000));
    assert.deepEqual(v, { ok: true, alreadyBound: false });
  });

  test("both ids are decided by one verdict, never separately", () => {
    // canBind has no way to express "candidate only" — the request type
    // requires both, so a half-bound lease is unrepresentable.
    const v = canBind(lease(), req(), at(1000));
    assert.equal(v.ok, true);
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    assert.match(store, /"videoId" IS NULL AND "runId" IS NULL/,
      "the UPDATE must require BOTH ids unbound, so binding cannot half-apply");
    assert.match(store, /SET "videoId"=\$2, "runId"=\$3/,
      "both ids must move in the same statement");
  });

  test("binding does not renew the heartbeat", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    const bind = store.slice(store.indexOf("export async function bindLease"),
      store.indexOf("export async function closeLease"));
    assert.ok(!bind.includes("heartbeatAt"),
      "binding must never move the heartbeat — that would let the pipeline fake supervision");
  });

  test("binding does not extend hard expiry", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    const bind = store.slice(store.indexOf("export async function bindLease"),
      store.indexOf("export async function closeLease"));
    assert.ok(!/SET[^;]*"expiresAt"=/.test(bind),
      "binding must never push out the hard ceiling");
  });

  test("binding does not change controller ownership", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    const bind = store.slice(store.indexOf("export async function bindLease"),
      store.indexOf("export async function closeLease"));
    assert.ok(!/SET[^;]*"controllerToken"=/.test(bind),
      "binding must never re-own the lease");
  });

  test("a bound lease still expires on its original schedule", () => {
    const bound = lease({ videoId: VIDEO, runId: RUN });
    const v = checkSupervisedLease({
      lease: bound, now: new Date(T0.getTime() + LEASE_MAX_LIFETIME_MS),
      channel: CHANNEL, pilotId: PILOT, videoId: VIDEO, runId: RUN,
    });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /expired/);
  });
});

// ── Monotonic narrowing ──────────────────────────────────────────────────

describe("narrowing is one-way", () => {
  const bound = () => lease({ videoId: VIDEO, runId: RUN });

  test("rebinding the identical execution is idempotent", () => {
    assert.deepEqual(canBind(bound(), req(), at(1000)), { ok: true, alreadyBound: true });
  });

  test("a different candidate cannot re-scope the lease", () => {
    const v = canBind(bound(), req({ videoId: "candidate-B" }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /already bound/);
  });

  test("a different run cannot re-scope the lease", () => {
    const v = canBind(bound(), req({ runId: "run-B" }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /already bound/);
  });

  test("unbound → A → B is impossible", () => {
    let l = lease();
    assert.equal(canBind(l, req(), at(1000)).ok, true);
    l = lease({ videoId: VIDEO, runId: RUN });          // A applied
    assert.equal(canBind(l, req({ videoId: "B", runId: "B" }), at(2000)).ok, false);
  });

  test("a half-bound row cannot be completed by a stranger", () => {
    // Not reachable through bindLease, but if a row were ever left half-bound
    // by hand it must not be adoptable.
    const half = lease({ videoId: VIDEO, runId: null });
    assert.equal(canBind(half, req({ runId: "run-B" }), at(1000)).ok, false);
  });
});

// ── Who may bind ─────────────────────────────────────────────────────────

describe("binding is scoped, not an open operation", () => {
  test("a foreign channel cannot bind", () => {
    const v = canBind(lease(), req({ channel: "wet-circuit" as never }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /belongs to ai-doom-scroll/);
  });

  test("an AI Doom lease cannot be bound by a Wet Circuit execution", () => {
    const v = canBind(lease({ channel: "wet-circuit" }), req(), at(1000));
    assert.equal(v.ok, false);
  });

  test("a foreign pilot cannot bind", () => {
    const v = canBind(lease(), req({ pilotId: "some-other-pilot" }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /pilot/);
  });

  test("a wrong controller token cannot bind", () => {
    const v = canBind(lease(), req({ controllerToken: "not-the-owner" }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /token/);
  });

  test("the owning token binds normally", () => {
    assert.equal(canBind(lease(), req({ controllerToken: TOKEN }), at(1000)).ok, true);
  });

  test("a closed lease cannot bind", () => {
    assert.equal(canBind(lease({ status: "CLOSED" }), req(), at(1000)).ok, false);
  });

  test("an expired lease cannot bind", () => {
    const v = canBind(lease(), req(), new Date(T0.getTime() + LEASE_MAX_LIFETIME_MS));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /hard expiry/);
  });

  test("a stale lease cannot bind — a dead controller grants nothing", () => {
    const v = canBind(lease(), req(), at(LEASE_STALE_AFTER_MS + 1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /controller is gone/);
  });

  test("there is no lease to bind when none exists", () => {
    assert.equal(canBind(null, req(), at(1000)).ok, false);
  });
});

// ── Downstream enforcement ───────────────────────────────────────────────

describe("the protected boundaries require the bound identity", () => {
  const boundLease = lease({ videoId: VIDEO, runId: RUN });
  const check = (o: { videoId?: string; runId?: string; lease?: SupervisedLeaseRow }) =>
    checkSupervisedLease({
      lease: o.lease ?? boundLease, now: at(1000), channel: CHANNEL, pilotId: PILOT,
      videoId: o.videoId, runId: o.runId, requireBound: true,
    });

  test("the exact execution passes", () => {
    assert.equal(check({ videoId: VIDEO, runId: RUN }).live, true);
  });

  test("a different candidate is refused", () => {
    const v = check({ videoId: "candidate-B", runId: RUN });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /bound to candidate/);
  });

  test("a different run is refused", () => {
    const v = check({ videoId: VIDEO, runId: "run-B" });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /bound to run/);
  });

  test("an unbound lease is refused outright at a protected boundary", () => {
    // This is the video-#1 state. Under the old code it passed every boundary.
    const v = check({ videoId: VIDEO, runId: RUN, lease: lease() });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /not bound to an execution/);
  });

  test("a half-bound lease is refused at a protected boundary", () => {
    const v = check({ videoId: VIDEO, runId: RUN, lease: lease({ videoId: VIDEO }) });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /not bound to an execution/);
  });

  test("all three protected boundaries ask for it", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    // narration
    assert.match(vo, /requireBound: true/, "the spend path must require a bound lease");
    assert.match(vo, /runId: ctx\.runId/);
    // render + upload share assertSupervisedBoundary
    const body = src.slice(src.indexOf("async function assertSupervisedBoundary"),
      src.indexOf("/**\n * Stamp the concrete execution identity"));
    assert.match(body, /requireBound: true/);
    assert.match(body, /runId: ctx\.runId/);
    assert.match(src, /guardedVideoAssembly[\s\S]*assertSupervisedBoundary\(ctx, "videoAssembly"\)/);
    assert.match(src, /assertSupervisedBoundary\(ctx, "youtubeUpload"\)/);
  });
});

// ── Controller death around the bind ─────────────────────────────────────

describe("controller death around binding", () => {
  test("dies before any candidate exists: the lease simply goes stale", () => {
    const v = checkSupervisedLease({
      lease: lease(), now: at(LEASE_STALE_AFTER_MS + 1000), channel: CHANNEL, pilotId: PILOT,
    });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /controller is gone/);
  });

  test("dies immediately before the bind: downstream cannot proceed indefinitely", () => {
    // The candidate exists, the lease does not name it, and the controller has
    // stopped beating. Both the bind and the boundary must refuse — a live
    // unbound lease must never become an open-ended licence.
    const late = at(LEASE_STALE_AFTER_MS + 1000);
    assert.equal(canBind(lease(), req(), late).ok, false);
    const v = checkSupervisedLease({
      lease: lease(), now: late, channel: CHANNEL, pilotId: PILOT,
      videoId: VIDEO, runId: RUN, requireBound: true,
    });
    assert.equal(v.live, false);
  });

  test("dies immediately before the bind, heartbeat still fresh: still refused downstream", () => {
    // Even inside the 90s stale window the boundary refuses, because the lease
    // names no execution. Without requireBound this is exactly the case that
    // would have sailed through.
    const v = checkSupervisedLease({
      lease: lease(), now: at(1000), channel: CHANNEL, pilotId: PILOT,
      videoId: VIDEO, runId: RUN, requireBound: true,
    });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /not bound/);
  });

  test("dies just after binding: identity stays fixed and expiry is normal", () => {
    const bound = lease({ videoId: VIDEO, runId: RUN });
    // Still inside the stale window: permitted.
    assert.equal(checkSupervisedLease({
      lease: bound, now: at(30_000), channel: CHANNEL, pilotId: PILOT,
      videoId: VIDEO, runId: RUN, requireBound: true,
    }).live, true);
    // Past it: refused, exactly as before binding existed.
    const v = checkSupervisedLease({
      lease: bound, now: at(LEASE_STALE_AFTER_MS + 1000), channel: CHANNEL, pilotId: PILOT,
      videoId: VIDEO, runId: RUN, requireBound: true,
    });
    assert.equal(v.live, false);
    assert.match((v as { reason: string }).reason, /controller is gone/);
    // And the identity did not drift.
    assert.equal(bound.videoId, VIDEO);
    assert.equal(bound.runId, RUN);
  });

  test("dies mid-bind: the row settles unbound or fully bound, never partial", () => {
    // Guaranteed by the shape of the statement, not by cleanup: one UPDATE
    // sets both columns under a both-null precondition.
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    const bind = store.slice(store.indexOf("export async function bindLease"),
      store.indexOf("export async function closeLease"));
    assert.equal((bind.match(/UPDATE "supervised_lease"/g) ?? []).length, 1,
      "one statement, so there is no window in which only one id is written");
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────

describe("two executions cannot both claim one lease", () => {
  test("the database arbitrates, not the caller", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/supervisedLeaseStore.ts", "utf8");
    const bind = store.slice(store.indexOf("export async function bindLease"),
      store.indexOf("export async function closeLease"));
    assert.match(bind, /"videoId" IS NULL AND "runId" IS NULL/,
      "the precondition must be in the WHERE clause, not a read-then-write");
    assert.ok(!/findUnique[\s\S]*updateMany/.test(bind),
      "a read-then-write would let two executions both believe they won");
  });

  test("the loser of the race is refused, with the winner named", () => {
    // Second execution re-reads and finds A's identity.
    const afterRace = lease({ videoId: VIDEO, runId: RUN });
    const v = canBind(afterRace, req({ videoId: "candidate-B", runId: "run-B" }), at(1000));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, new RegExp(VIDEO));
  });

  test("a concurrent duplicate of the SAME execution still succeeds", () => {
    const afterRace = lease({ videoId: VIDEO, runId: RUN });
    assert.deepEqual(canBind(afterRace, req(), at(1000)), { ok: true, alreadyBound: true });
  });

  test("the loser cannot fall back to the broader authority", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    const body = src.slice(src.indexOf("async function bindSupervisedIdentity"),
      src.indexOf("/** Render is the first materially"));
    assert.match(body, /if \(!bound\.bound\)[\s\S]*success: false/);
  });
});

// ── The run identity has to exist to be bound ────────────────────────────

describe("a run is nameable from its first moment", () => {
  test("RunSummary mints its id at construction, not at persist", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/pipelineRun.ts", "utf8");
    assert.match(src, /readonly runId: string = randomUUID\(\)/);
    assert.match(src, /id: this\.runId/,
      "the persisted row must carry the same id the run was bound under");
  });

  test("the pipeline binds with the summary's id", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    assert.match(src, /bindSupervisedIdentity\(video\.id, summary\?\.runId\)/);
    assert.match(src, /bindSupervisedIdentity\(stuckVideo\.id, summary\?\.runId\)/);
  });

  test("a supervised pilot run with no run identity is refused", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    const body = src.slice(src.indexOf("async function bindSupervisedIdentity"),
      src.indexOf("/** Render is the first materially"));
    assert.match(body, /if \(!runId\)/);
    assert.match(body, /no run identity available/);
  });
});

// ── Scope: this is the pilot path only ───────────────────────────────────

describe("binding is scoped to supervised pilot execution", () => {
  test("unattended cycles and ordinary production skip it", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    const body = src.slice(src.indexOf("async function bindSupervisedIdentity"),
      src.indexOf("/** Render is the first materially"));
    assert.match(body, /if \(activeCycle\) return null;/);
    assert.match(body, /if \(!pilot\) return null;/);
  });

  test("Wet Circuit binds nothing and is untouched", () => {
    const wc = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
    assert.ok(!/bindLease|bindSupervisedIdentity/.test(wc));
  });
});

// ── The qualification #1 regression, end to end ──────────────────────────

/**
 * The exact sequence that produced video #1, replayed against the new rules.
 *
 * No ElevenLabs, no YouTube, no render — this is the authorization state
 * machine only. It exists so the next qualification attempt cannot silently
 * repeat the unbound-lease state, which is invisible unless something asks.
 */
describe("qualification #1 replayed: the lease is scoped this time", () => {
  test("open → create candidate → create run → bind → every boundary agrees", () => {
    // 1. Controller opens a lease. Nothing to bind yet.
    let l = lease();
    assert.equal(l.videoId, null);
    assert.equal(l.runId, null);

    // 2. Startup gate, before any candidate: unbound is fine here.
    assert.equal(checkSupervisedLease({
      lease: l, now: at(1000), channel: CHANNEL, pilotId: PILOT,
    }).live, true);

    // 3. Candidate and run acquire identity together.
    const verdict = canBind(l, req(), at(2000));
    assert.deepEqual(verdict, { ok: true, alreadyBound: false });
    l = lease({ videoId: VIDEO, runId: RUN });

    // 4. Narration, render and upload all check the same scoped question.
    for (const boundary of ["narration", "render", "upload"]) {
      assert.equal(checkSupervisedLease({
        lease: l, now: at(3000), channel: CHANNEL, pilotId: PILOT,
        videoId: VIDEO, runId: RUN, requireBound: true,
      }).live, true, boundary);
    }

    // 5. A second candidate is refused at every one of them.
    for (const boundary of ["narration", "render", "upload"]) {
      const v = checkSupervisedLease({
        lease: l, now: at(3000), channel: CHANNEL, pilotId: PILOT,
        videoId: "a-second-candidate", runId: "a-second-run", requireBound: true,
      });
      assert.equal(v.live, false, boundary);
      assert.match((v as { reason: string }).reason, /bound to candidate/);
    }
  });

  test("the video-#1 lease state would now be refused before any spend", () => {
    // videoId: null, runId: null — precisely what was in the database.
    const asItWas = lease();
    const v = checkSupervisedLease({
      lease: asItWas, now: at(3000), channel: CHANNEL, pilotId: PILOT,
      videoId: VIDEO, runId: RUN, requireBound: true,
    });
    assert.equal(v.live, false,
      "an unbound lease must no longer authorise a narration purchase");
    assert.match((v as { reason: string }).reason, /not bound to an execution/);
  });
});
