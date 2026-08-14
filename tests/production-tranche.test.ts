import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAuthorizeTranche, canClaimSlot, checkSlotAuthority, liveTranche,
  remainingCandidates, settlementFor, classifyTranchePhase, tranchesNeedingRecovery,
  authorizeNarrationWindow, uploadPolicyFor, nextPublishSlot,
  TRANCHE_MAX_CANDIDATES, TRANCHE_MAX_LIFETIME_MS, TRANCHE_DEFAULT_LIFETIME_MS,
} from "@yt-pipeline/pipeline-core";
import type {
  ProductionTrancheRow, ProductionTrancheSlotRow, PilotConfig,
} from "@yt-pipeline/pipeline-core";

/**
 * Finite production authorization.
 *
 * Qualification proved AI Doom can make an acceptable video, and the pilot
 * closed. What graduation deliberately did NOT do is hand the channel a
 * chequebook: `authorizeNarrationWindow` required a named ACTIVE pilot, so a
 * graduated channel reached the voiceover stage and could buy nothing. Measured
 * on the real row after graduation:
 *
 *   PILOT_ID unset   → "no pilot governs this channel — ordinary production
 *                       may not open a budget"
 *   PILOT_ID set     → "pilot ai-doom-private-pilot-1 is COMPLETED, not ACTIVE"
 *
 * The fix is not to relax that. It is to give production its own bounded
 * authority, so the property the whole qualification effort was built around
 * survives into production:
 *
 *   Nothing spends because production is "enabled". It spends because durable
 *   state says how many attempts were authorized, by whom, and until when.
 */

const CH = "ai-doom-scroll" as const;
const T0 = new Date("2026-08-14T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3600_000;

function tranche(over: Partial<ProductionTrancheRow> = {}): ProductionTrancheRow {
  return {
    id: "tr-1", channel: CH, maxCandidates: 1, consumedCandidates: 0,
    status: "ACTIVE", shortsEnabled: false, authorizedBy: "operator",
    policyCommit: "abc1234", authorizedAt: T0,
    expiresAt: new Date(T0.getTime() + 48 * HOUR),
    closedAt: null, closedReason: null, ...over,
  };
}

function slot(over: Partial<ProductionTrancheSlotRow> = {}): ProductionTrancheSlotRow {
  return {
    id: "slot-1", trancheId: "tr-1", channel: CH, slotIndex: 0, status: "CLAIMED",
    videoId: "vid-A", runId: "run-A", claimedAt: T0, settledAt: null, outcome: null,
    ...over,
  };
}

const PILOT: PilotConfig = {
  id: "row", pilotId: "ai-doom-private-pilot-1", channel: CH, channelId: "UC",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: T0, completedAt: null, privacyStatus: "private",
  allowPublishAt: false, shortsEnabled: false, requireFeasibility: true,
  requireGuardedUpload: true, windowDays: [1, 3, 5], windowStartHour: 17,
  windowEndHour: 20, timezone: "America/New_York",
};

const askWindow = (o: Record<string, unknown> = {}) => authorizeNarrationWindow({
  channel: CH as never, stage: "PRODUCTION" as never, pilot: null,
  submitChars: 5500, unattended: false, elevenDisabled: false, ...o,
} as never);

// ── 1-13. Authorization ──────────────────────────────────────────────────

describe("1-13. what may authorize production spend", () => {
  const req = (o: Record<string, unknown> = {}) => canAuthorizeTranche({
    channel: CH as never, count: 1, graduated: true, existing: null, now: T0, ...o,
  } as never);

  test("1. a graduated channel with no tranche cannot open a narration budget", () => {
    const d = askWindow({ pilot: null });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /no pilot and no production tranche slot/);
  });

  test("2. a COMPLETED pilot alone grants no production spend", () => {
    const d = askWindow({ pilot: { ...PILOT, status: "COMPLETED" } });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /COMPLETED, not ACTIVE/);
  });

  test("3. a valid tranche slot authorizes ordinary production", () => {
    const d = askWindow({ pilot: null, productionSlot: { authorized: true, slotId: "slot-1" } });
    assert.equal(d.open, true);
    assert.equal((d as { auth: { source: string } }).auth.source, "production-tranche");
  });

  test("4/5. the count must be a positive bounded integer", () => {
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, TRANCHE_MAX_CANDIDATES + 1]) {
      assert.equal(req({ count }).ok, false, `count ${count} was accepted`);
    }
    assert.equal(req({ count: 1 }).ok, true);
    assert.equal(req({ count: TRANCHE_MAX_CANDIDATES }).ok, true);
  });

  test("6/7. an expiry is mandatory and bounded", () => {
    assert.equal(req({ lifetimeMs: 0 }).ok, false);
    assert.equal(req({ lifetimeMs: -1 }).ok, false);
    assert.equal(req({ lifetimeMs: Number.POSITIVE_INFINITY }).ok, false);
    assert.equal(req({ lifetimeMs: TRANCHE_MAX_LIFETIME_MS + 1 }).ok, false);
    const ok = req({ lifetimeMs: 6 * HOUR });
    assert.equal(ok.ok, true);
    assert.equal((ok as { expiresAt: Date }).expiresAt.getTime(), T0.getTime() + 6 * HOUR);
  });

  test("the default lifetime is used when none is given", () => {
    const r = req({});
    assert.equal((r as { expiresAt: Date }).expiresAt.getTime(),
      T0.getTime() + TRANCHE_DEFAULT_LIFETIME_MS);
  });

  test("8. a live tranche blocks authorizing a second one", () => {
    const r = req({ existing: tranche() });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /still live/);
  });

  test("an exhausted or expired tranche does not block a new authorization", () => {
    assert.equal(req({ existing: tranche({ consumedCandidates: 1 }) }).ok, true);
    assert.equal(req({ existing: tranche(), now: at(72 * HOUR) }).ok, true);
    assert.equal(req({ existing: tranche({ status: "CLOSED" }) }).ok, true);
  });

  test("10. a channel that has not graduated cannot be authorized", () => {
    const r = req({ graduated: false });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /not completed its qualification pilot/);
  });

  test("11. the ACTIVE pilot path is untouched", () => {
    const d = askWindow({ pilot: PILOT, supervised: true });
    assert.equal(d.open, true);
    assert.equal((d as { auth: { source: string } }).auth.source, "pilot");
    assert.equal((d as { auth: { pilotId: string } }).auth.pilotId, PILOT.pilotId);
  });

  test("12. production authority cannot be mistaken for pilot authority", () => {
    const d = askWindow({ pilot: PILOT, supervised: true, productionSlot: { authorized: true } });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /ambiguous authority/);
  });

  test("13. an unknown execution context fails closed", () => {
    assert.equal(askWindow({ pilot: null, productionSlot: null }).open, false);
    assert.equal(askWindow({ pilot: null, productionSlot: { authorized: false } }).open, false);
  });
});

// ── 14-25. Slot claiming ─────────────────────────────────────────────────

describe("14-25. taking exactly one authorized attempt", () => {
  const claim = (t: ProductionTrancheRow | null, o: Record<string, unknown> = {}) =>
    canClaimSlot(t, { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR), ...o } as never);

  test("14. an N=1 tranche permits exactly one claim", () => {
    assert.deepEqual(claim(tranche()), { ok: true, slotIndex: 0 });
    // After the first claim the counter has moved; the second is refused.
    const after = tranche({ consumedCandidates: 1 });
    assert.equal(claim(after).ok, false);
    assert.match((claim(after) as { reason: string }).reason, /exhausted/);
  });

  test("15. the winner of a race is decided by the counter, not the caller", () => {
    // Two claimers see the same row; the transaction serialises them, so the
    // loser re-reads a consumed tranche. Modelled here as the state each sees.
    assert.equal(claim(tranche({ consumedCandidates: 0 })).ok, true);
    assert.equal(claim(tranche({ consumedCandidates: 1 })).ok, false);
  });

  test("16. a claim needs both a candidate and a run", () => {
    assert.equal(claim(tranche(), { videoId: "" }).ok, false);
    assert.equal(claim(tranche(), { runId: "" }).ok, false);
  });

  test("17/18. a slot authorizes only its exact candidate and run", () => {
    const s = slot();
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    const ask = (videoId: string, runId: string) =>
      checkSlotAuthority(s, t, { channel: CH as never, videoId, runId, now: at(HOUR) });
    assert.equal(ask("vid-A", "run-A").authorized, true);
    const wrongV = ask("vid-B", "run-A");
    assert.equal(wrongV.authorized, false);
    assert.match((wrongV as { reason: string }).reason, /bound to candidate vid-A/);
    const wrongR = ask("vid-A", "run-B");
    assert.equal(wrongR.authorized, false);
    assert.match((wrongR as { reason: string }).reason, /bound to run run-A/);
  });

  test("19. a foreign channel cannot use the slot", () => {
    const r = checkSlotAuthority(slot(), tranche(),
      { channel: "wet-circuit" as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) });
    assert.equal(r.authorized, false);
  });

  test("9. a tranche never authorizes another channel's candidate", () => {
    const r = canClaimSlot(tranche({ channel: "wet-circuit" }),
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /authorizes wet-circuit/);
  });

  test("20. re-asking with the same identity is stable", () => {
    const s = slot();
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    for (let i = 0; i < 3; i++) {
      assert.equal(checkSlotAuthority(s, t,
        { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, true);
    }
  });

  test("21/22. a failed attempt still consumed its slot", () => {
    // The tranche counter is incremented at claim time, so a candidate that
    // fails before spending has still used the attempt it was given. Refunding
    // failures would make N a count of successes, not of attempts.
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(remainingCandidates(t), 0);
    assert.equal(liveTranche(t, at(HOUR)).live, false);
    const settled = slot({ status: "SETTLED_FAILED", outcome: "quality gate failed" });
    assert.equal(checkSlotAuthority(settled, t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, false);
  });

  test("23. a successful candidate exhausts an N=1 tranche", () => {
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(classifyTranchePhase(t, [slot({ status: "SETTLED_SUCCESS" })], at(HOUR)), "EXHAUSTED");
    assert.equal(liveTranche(t, at(HOUR)).live, false);
  });

  test("24. an ambiguous terminal state does not make the slot reusable", () => {
    assert.equal(settlementFor("AMBIGUOUS"), "RECONCILIATION_REQUIRED");
    const s = slot({ status: "RECONCILIATION_REQUIRED" });
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(checkSlotAuthority(s, t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, false);
    assert.equal(classifyTranchePhase(t, [s], at(HOUR)), "RECONCILIATION_REQUIRED");
  });

  test("25. reconciliation can only retire, never restore capacity", () => {
    const expired = tranche();
    const exhausted = tranche({ id: "tr-2", consumedCandidates: 1 });
    const out = tranchesNeedingRecovery([expired, exhausted], at(72 * HOUR));
    assert.equal(out.length, 2);
    for (const o of out) assert.ok(["EXPIRED", "EXHAUSTED"].includes(o.status));
    // Idempotent: rows already terminal are never revisited.
    assert.deepEqual(
      tranchesNeedingRecovery([tranche({ status: "EXPIRED" }), tranche({ status: "CLOSED" })], at(72 * HOUR)),
      []);
  });

  test("settlement maps outcomes without inventing a fourth state", () => {
    assert.equal(settlementFor("SUCCESS"), "SETTLED_SUCCESS");
    assert.equal(settlementFor("FAILED"), "SETTLED_FAILED");
  });
});

// ── 26-35. Narration ─────────────────────────────────────────────────────

describe("26-35. the narration window under production authority", () => {
  const ok = { authorized: true, slotId: "slot-1" };

  test("26. a bound slot opens the existing candidate-scoped window", () => {
    const d = askWindow({ pilot: null, productionSlot: ok, submitChars: 5528 });
    assert.equal(d.open, true);
    const a = (d as { auth: { submitChars: number; ceilingChars: number } }).auth;
    assert.equal(a.submitChars, 5528, "the window is the candidate's own size");
    assert.ok(a.ceilingChars >= a.submitChars);
  });

  test("27. a request above the durable ceiling fails before spend", () => {
    const d = askWindow({ pilot: null, productionSlot: ok, submitChars: 999_999 });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /exceeds the .* ceiling/);
  });

  test("the ceiling is runtime-derived, not caller-supplied", () => {
    const a = (askWindow({ pilot: null, productionSlot: ok }) as { auth: { ceilingChars: number } }).auth;
    const b = (askWindow({ pilot: PILOT, supervised: true }) as { auth: { ceilingChars: number } }).auth;
    assert.equal(a.ceilingChars, b.ceilingChars,
      "production and pilot share one durable ceiling for the same channel/stage");
  });

  test("28. DISABLE_ELEVEN blocks even a valid tranche", () => {
    const d = askWindow({ pilot: null, productionSlot: ok, elevenDisabled: true });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /DISABLE_ELEVEN/);
  });

  test("the hard disable is checked before any authority", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/narrationWindow.ts", "utf8");
    const body = src.slice(src.indexOf("export function authorizeNarrationWindow"));
    assert.ok(body.indexOf("elevenDisabled") < body.indexOf("productionSlot"),
      "a tranche must never be able to get narration past DISABLE_ELEVEN");
  });

  test("unattended execution may not use a tranche either", () => {
    const d = askWindow({ pilot: null, productionSlot: ok, unattended: true });
    assert.equal(d.open, false);
    assert.match((d as { reason: string }).reason, /unattended/);
  });

  test("29/30/31. the window is temporary — the standing limit is never raised", () => {
    const budget = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
    const w = budget.slice(budget.indexOf("export async function withBudgetWindow"));
    assert.match(w, /finally/, "the window must be closed whatever happens");
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.match(vo, /withBudgetWindow\(channel, stage, auth\.submitChars/);
    // Nothing in the tranche path writes a standing limit.
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    for (const forbidden of ["setBudgetLimit", "limitChars", "DISABLE_ELEVEN"]) {
      assert.ok(!store.includes(forbidden),
        `the tranche store must not touch ${forbidden} — it authorizes, it does not fund`);
    }
  });

  test("32/33. reservation accounting and the breaker are untouched", () => {
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    // Named in prose only. The stage must not CALL it — reservation belongs to
    // the shared voiceover implementation inside the window.
    assert.ok(!/reserveCredits\(/.test(vo), "the stage must not bypass shared reservation logic");
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    assert.ok(!/circuitBreaker|assertCircuitClosed/.test(store),
      "the tranche must not be able to reopen a tripped breaker");
  });

  test("34. there is no production side door without a tranche", () => {
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.match(vo, /verifyProductionSlot\(/);
    assert.match(vo, /productionSlot:/);
    // The only way to a window is through the decision function.
    assert.equal((vo.match(/withBudgetWindow\(/g) ?? []).length, 1);
  });

  test("35. production cannot create its own capacity", () => {
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    assert.ok(!pipeline.includes("authorizeTranche"),
      "the pipeline must never author its own authorization");
    const vo = readFileSync("packages/pipeline-core/src/stages/voiceover.ts", "utf8");
    assert.ok(!vo.includes("authorizeTranche") && !vo.includes("claimSlot"),
      "the spend path must consume authority, never mint it");
  });
});

// ── 36-42. Shorts and scheduling ─────────────────────────────────────────

describe("36-42. first-tranche policy: long-form only, still staged", () => {
  const SLOT_TIME = new Date("2026-08-17T19:00:00.000Z");

  test("36. Shorts are off unless the tranche enables them", () => {
    assert.equal(uploadPolicyFor(null, SLOT_TIME).shortsEnabled, false);
    assert.equal(uploadPolicyFor(null, SLOT_TIME, { shortsEnabled: false }).shortsEnabled, false);
    assert.equal(uploadPolicyFor(null, SLOT_TIME, null).shortsEnabled, false,
      "absent policy must mean off, never on");
  });

  test("37. long-form is unaffected", () => {
    const p = uploadPolicyFor(null, SLOT_TIME, { shortsEnabled: false });
    assert.equal(p.scheduledSlot, SLOT_TIME);
    assert.equal(p.privacyStatus, "private");
    assert.equal(p.requireGuardedUpload, true);
  });

  test("38. ordinary production still stages a future publishAt", () => {
    const p = uploadPolicyFor(null, SLOT_TIME, { shortsEnabled: false });
    assert.equal(p.scheduledSlot, SLOT_TIME, "staging is private-now, public-at-publishAt");
    assert.equal(p.source, "normal");
  });

  test("39. the slot uses the existing M/W/F 15:00 ET cadence", () => {
    // Deterministic clock: a Friday afternoon rolls to the next Monday slot.
    const from = new Date("2026-08-14T19:30:00.000Z");
    const s = nextPublishSlot(from, { occupied: [] });
    assert.ok(s.getTime() > from.getTime());
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", weekday: "short", hour12: false,
    }).formatToParts(s);
    assert.equal(parts.find((p) => p.type === "hour")?.value, "15");
    assert.ok(["Mon", "Wed", "Fri"].includes(parts.find((p) => p.type === "weekday")?.value ?? ""));
  });

  test("40. an occupied slot is skipped, never doubled up", () => {
    const from = new Date("2026-08-14T19:30:00.000Z");
    const first = nextPublishSlot(from, { occupied: [] });
    const second = nextPublishSlot(from, { occupied: [first] });
    assert.notEqual(second.getTime(), first.getTime());
    assert.ok(second.getTime() > first.getTime());
  });

  test("41. pilot uploads remain private and unscheduled", () => {
    const p = uploadPolicyFor(PILOT, SLOT_TIME);
    assert.equal(p.privacyStatus, "private");
    assert.equal(p.scheduledSlot, null, "a pilot never carries a publish time");
    assert.equal(p.shortsEnabled, false);
    assert.equal(p.source, "pilot");
  });

  test("42. a later tranche can enable Shorts without rewriting history", () => {
    assert.equal(uploadPolicyFor(null, SLOT_TIME, { shortsEnabled: true }).shortsEnabled, true);
    // The first tranche's own row still says false — policy is per-tranche.
    assert.equal(tranche().shortsEnabled, false);
  });
});

// ── 43-51. Crash, expiry, concurrency ────────────────────────────────────

describe("43-51. what happens when things stop halfway", () => {
  test("43. authorization with no candidate started authorizes nobody in particular", () => {
    const t = tranche();
    assert.equal(classifyTranchePhase(t, [], at(HOUR)), "AUTHORIZED");
    assert.equal(liveTranche(t, at(HOUR)).live, true);
    // Nothing is bound, so no candidate holds authority yet.
    assert.equal(checkSlotAuthority(null, t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, false);
  });

  test("44. a claimed slot survives controller death, still bound and not reusable", () => {
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    const s = slot();
    assert.equal(classifyTranchePhase(t, [s], at(HOUR)), "SLOT_IN_FLIGHT");
    // Its own execution may continue; nobody else may take it.
    assert.equal(checkSlotAuthority(s, t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, true);
    assert.equal(checkSlotAuthority(s, t,
      { channel: CH as never, videoId: "vid-B", runId: "run-B", now: at(HOUR) }).authorized, false);
    assert.equal(canClaimSlot(t, { channel: CH as never, videoId: "vid-B", runId: "run-B", now: at(HOUR) }).ok,
      false, "a dead controller's tranche must not fund a replacement candidate");
  });

  test("45. expiry before the claim blocks execution", () => {
    const r = canClaimSlot(tranche(), {
      channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(72 * HOUR),
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /expired/);
  });

  test("46. expiry after binding but before narration blocks the spend", () => {
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    const r = checkSlotAuthority(slot(), t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(72 * HOUR) });
    assert.equal(r.authorized, false);
    assert.match((r as { reason: string }).reason, /ran out before this candidate reached spend/);
  });

  test("the last authorized candidate may still use the slot it holds", () => {
    // EXHAUSTED means "no more claims", not "the holder loses authority".
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(checkSlotAuthority(slot(), t,
      { channel: CH as never, videoId: "vid-A", runId: "run-A", now: at(HOUR) }).authorized, true);
  });

  test("47/48. spend-then-failure and upload ambiguity create no new slot", () => {
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    for (const st of ["SETTLED_FAILED", "RECONCILIATION_REQUIRED"] as const) {
      assert.equal(canClaimSlot(t,
        { channel: CH as never, videoId: "vid-B", runId: "run-B", now: at(HOUR) }).ok, false, st);
      assert.equal(remainingCandidates(t), 0);
    }
  });

  test("49/50. reconciliation is idempotent and never adds capacity", () => {
    const t = tranche();
    const once = tranchesNeedingRecovery([t], at(72 * HOUR));
    const twice = tranchesNeedingRecovery([t], at(72 * HOUR));
    assert.deepEqual(once.map((o) => o.status), twice.map((o) => o.status));
    for (const o of [...once, ...twice]) {
      assert.ok(o.status === "EXPIRED" || o.status === "EXHAUSTED");
    }
    assert.equal(remainingCandidates(t), 1, "recovery must not mutate the count");
  });

  test("51. an exhausted tranche refuses a second controller invocation", () => {
    const t = tranche({ consumedCandidates: 1, status: "EXHAUSTED" });
    assert.equal(liveTranche(t, at(HOUR)).live, false);
    assert.equal(canClaimSlot(t,
      { channel: CH as never, videoId: "vid-B", runId: "run-B", now: at(HOUR) }).ok, false);
  });

  test("phases an operator can act on, without reading tables", () => {
    assert.equal(classifyTranchePhase(null, [], T0), "NO_AUTHORIZATION");
    assert.equal(classifyTranchePhase(tranche(), [], at(HOUR)), "AUTHORIZED");
    assert.equal(classifyTranchePhase(tranche(), [slot()], at(HOUR)), "SLOT_IN_FLIGHT");
    assert.equal(classifyTranchePhase(tranche({ consumedCandidates: 1 }),
      [slot({ status: "SETTLED_SUCCESS" })], at(HOUR)), "EXHAUSTED");
    assert.equal(classifyTranchePhase(tranche(), [], at(72 * HOUR)), "EXPIRED");
    assert.equal(classifyTranchePhase(tranche({ status: "CLOSED" }), [], at(HOUR)), "CLOSED");
    assert.equal(classifyTranchePhase(tranche(),
      [slot({ status: "RECONCILIATION_REQUIRED" })], at(HOUR)), "RECONCILIATION_REQUIRED");
  });
});

// ── 52-62. Nothing else moved ────────────────────────────────────────────

describe("52-62. the rest of the system is unchanged", () => {
  test("55. Wet Circuit keeps the ACTIVE-pilot narration path", () => {
    const wc = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
    assert.match(wc, /currentPilot/);
    assert.ok(!/verifyProductionSlot|claimSlot|authorizeTranche/.test(wc),
      "WC is pre-qualification and must keep its pilot authority untouched");
    const d = authorizeNarrationWindow({
      channel: "wet-circuit" as never, stage: "PRODUCTION" as never,
      pilot: { ...PILOT, pilotId: "wet-circuit-private-canary-1", channel: "wet-circuit" },
      submitChars: 4000, unattended: false, elevenDisabled: false,
    } as never);
    assert.equal(d.open, true);
    assert.equal((d as { auth: { source: string } }).auth.source, "pilot");
  });

  test("the tranche is production-only — no pilot path consults it", () => {
    const src = readFileSync("src/pipeline.ts", "utf8");
    const body = src.slice(src.indexOf("async function claimProductionAttempt"),
      src.indexOf("/** Render is the first materially"));
    assert.match(body, /if \(activeCycle\) return null;/);
    assert.match(body, /if \(pilot\) return null;/,
      "a pilot run must never consume production capacity");
  });

  test("62. no tranche is NOT_AUTHORIZED, not a fault", () => {
    const ctrl = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.match(ctrl, /"NOT_AUTHORIZED"/);
    assert.match(ctrl, /resting state of a healthy\s+\*?\s*\/\/?\s*production channel|resting state/);
    // The phase exists so an operator is told what to do, not that it broke.
    assert.match(ctrl, /production-tranche-control\.ts --channel/);
  });

  test("authorization is never a side effect of running", () => {
    const ctrl = readFileSync("scripts/ordinary-production-control.ts", "utf8");
    assert.ok(!ctrl.includes("authorizeTranche"),
      "the run control must not be able to authorize its own spend");
    const tr = readFileSync("scripts/production-tranche-control.ts", "utf8");
    for (const forbidden of ["invokePipeline", "runPipeline", "setVars", "DISABLE_ELEVEN=false"]) {
      assert.ok(!tr.includes(forbidden),
        `authorizing must not ${forbidden} — it grants permission, it does not act`);
    }
  });

  test("the authorization command is unmistakably spend-authorizing", () => {
    const tr = readFileSync("scripts/production-tranche-control.ts", "utf8");
    assert.match(tr, /--i-understand-this-authorizes-real-production-spend/);
    assert.match(tr, /--authorize requires/);
  });
});
