import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateCycleHealth, checkUnclaimed, checkStaleClaim, checkTerminal,
  checkLinkage, checkSingleOpenCycle, checkMissedSlots, checkGateCoherence,
  CLAIM_STALE_AFTER_MS, MINIMUM_LEAD_MS,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, CycleHealthInput } from "@yt-pipeline/pipeline-core";
import {
  dedupeAlerts, newAlertState, formatResolved, RENOTIFY_AFTER_MS,
} from "../packages/monitor/src/lib/alertDedup";

/**
 * Observability for unattended production.
 *
 * Two properties matter and pull against each other: every genuinely actionable
 * state must produce a finding, and no designed state may produce one. An alert
 * set that fires on normal operation is worse than none, because it trains the
 * operator to ignore the channel that carries the real incident.
 */

const AI = "ai-doom-scroll";
const NOW = new Date("2026-08-10T12:00:00Z");
const SLOT = new Date("2026-08-10T19:00:00Z"); // Mon 15:00 ET, 7h away

function cyc(over: Partial<ProductionCycle> = {}): ProductionCycle {
  return {
    id: "c1", channel: AI, targetPublishSlot: SLOT, status: "AUTHORIZED",
    claimantId: null, videoId: null, pipelineRunId: null, failureCode: null,
    authorizedAt: NOW, claimedAt: null, completedAt: null, failedAt: null, ...over,
  };
}

function input(over: Partial<CycleHealthInput> = {}): CycleHealthInput {
  return {
    channel: AI, cycles: [], recentSlots: [], scheduledSlotInstants: [],
    schedulerEnabled: true, unattendedEnabled: true, now: NOW, ...over,
  };
}

const codes = (fs: { code: string }[]): string[] => fs.map((f) => f.code);

// ── Designed states must stay silent ──────────────────────────────────────

describe("designed states never alert", () => {
  test("an AUTHORIZED cycle waiting well before its slot is silent", () => {
    assert.deepEqual(checkUnclaimed(cyc(), NOW), []);
  });

  test("a freshly CLAIMED cycle is silent", () => {
    assert.deepEqual(checkStaleClaim(cyc({
      status: "CLAIMED", claimantId: "unattended:ai-doom-scroll",
      claimedAt: new Date(NOW.getTime() - 60_000),
    }), NOW), []);
  });

  test("a COMPLETED cycle with its video is silent", () => {
    const c = cyc({ status: "COMPLETED", videoId: "v1", claimantId: "x" });
    assert.deepEqual([...checkTerminal(c), ...checkLinkage(c)], []);
  });

  test("one open cycle is silent", () => {
    assert.deepEqual(checkSingleOpenCycle(AI, [cyc()], NOW), []);
  });

  test("a fully healthy channel produces no findings at all", () => {
    const r = evaluateCycleHealth(input({ cycles: [cyc()] }));
    assert.deepEqual(r.findings, []);
    assert.equal(r.healthy, true);
  });

  test("both gates off is a deliberate resting state, not a finding", () => {
    assert.deepEqual(checkGateCoherence(
      input({ schedulerEnabled: false, unattendedEnabled: false })), []);
  });

  test("a slot missed while the system is switched off is not a miss", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    for (const gates of [
      { schedulerEnabled: false, unattendedEnabled: false },
      { schedulerEnabled: false, unattendedEnabled: true },
      { schedulerEnabled: true, unattendedEnabled: false },
    ]) {
      assert.deepEqual(
        checkMissedSlots(input({ recentSlots: [past], ...gates })), [],
        `gates ${JSON.stringify(gates)} must not report a miss`);
    }
  });
});

// ── Actionable states must be caught ──────────────────────────────────────

describe("actionable states alert", () => {
  test("AUTHORIZED with too little time left to run", () => {
    const late = new Date(SLOT.getTime() - MINIMUM_LEAD_MS + 60_000);
    assert.deepEqual(codes(checkUnclaimed(cyc(), late)), ["CYCLE_NOT_CLAIMED_IN_TIME"]);
  });

  test("AUTHORIZED whose slot has passed entirely", () => {
    const after = new Date(SLOT.getTime() + 60_000);
    assert.deepEqual(codes(checkUnclaimed(cyc(), after)), ["CYCLE_SLOT_PASSED_UNCLAIMED"]);
  });

  test("a claim older than the stale threshold", () => {
    const c = cyc({ status: "CLAIMED", claimantId: "unattended:ai-doom-scroll",
      claimedAt: new Date(NOW.getTime() - CLAIM_STALE_AFTER_MS - 60_000) });
    const f = checkStaleClaim(c, NOW);
    assert.deepEqual(codes(f), ["CYCLE_CLAIM_STALE"]);
    assert.match(f[0].detail, /never reap without inspecting/);
  });

  test("RECONCILIATION_REQUIRED is an ALERT and says never retry", () => {
    const f = checkTerminal(cyc({ status: "RECONCILIATION_REQUIRED", failureCode: "youtubeUpload: timeout" }));
    assert.deepEqual(codes(f), ["CYCLE_RECONCILIATION_REQUIRED"]);
    assert.equal(f[0].severity, "ALERT");
    assert.match(f[0].detail, /never retry/);
  });

  test("FAILED is a WARN, because nothing reached YouTube", () => {
    const f = checkTerminal(cyc({ status: "FAILED", failureCode: "voiceover: boom" }));
    assert.equal(f[0].severity, "WARN");
  });

  const impossible: [string, Partial<ProductionCycle>, string][] = [
    ["COMPLETED without a video", { status: "COMPLETED", videoId: null }, "CYCLE_COMPLETED_WITHOUT_VIDEO"],
    ["AUTHORIZED already bound", { status: "AUTHORIZED", videoId: "v1" }, "CYCLE_UNCLAIMED_WITH_VIDEO"],
    ["CLAIMED with no claimant", { status: "CLAIMED", claimantId: null }, "CYCLE_CLAIMED_WITHOUT_CLAIMANT"],
  ];
  for (const [label, over, code] of impossible) {
    test(`impossible linkage: ${label}`, () => {
      assert.ok(codes(checkLinkage(cyc(over))).includes(code));
    });
  }

  test("two open cycles for one channel", () => {
    const f = checkSingleOpenCycle(AI, [cyc({ id: "a" }), cyc({ id: "b" })], NOW);
    assert.deepEqual(codes(f), ["CYCLE_MULTIPLE_OPEN"]);
    assert.match(f[0].detail, /at most one video may ever be owed/);
  });

  test("a missed slot is reported when the system was armed", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    const f = checkMissedSlots(input({ recentSlots: [past] }));
    assert.deepEqual(codes(f), ["SLOT_MISSED"]);
    assert.equal(f[0].severity, "WARN", "a gap in output is not a safety incident");
  });

  test("a slot with a COMPLETED cycle is not missed", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    assert.deepEqual(checkMissedSlots(input({
      recentSlots: [past],
      cycles: [cyc({ targetPublishSlot: past, status: "COMPLETED", videoId: "v1" })],
    })), []);
  });

  test("a slot with a published video is not missed even without a cycle", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    assert.deepEqual(checkMissedSlots(input({
      recentSlots: [past], scheduledSlotInstants: [past.getTime()],
    })), []);
  });

  test("gate mismatch is reported in both directions", () => {
    assert.deepEqual(codes(checkGateCoherence(
      input({ schedulerEnabled: true, unattendedEnabled: false }))),
      ["SCHEDULER_ARMED_WITHOUT_RUNTIME"]);
    assert.deepEqual(codes(checkGateCoherence(
      input({ schedulerEnabled: false, unattendedEnabled: true }))),
      ["RUNTIME_ARMED_WITHOUT_SCHEDULER"]);
  });

  test("healthy is false only when an ALERT exists, not a WARN", () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    const warnOnly = evaluateCycleHealth(input({ recentSlots: [past] }));
    assert.ok(warnOnly.findings.length > 0);
    assert.equal(warnOnly.healthy, true, "a WARN must not mark the channel unhealthy");

    const alerting = evaluateCycleHealth(input({
      cycles: [cyc({ status: "RECONCILIATION_REQUIRED" })] }));
    assert.equal(alerting.healthy, false);
  });

  test("the evaluator is pure — same input, same output, no mutation", () => {
    const i = input({ cycles: [cyc({ status: "FAILED" })] });
    const frozen = JSON.stringify(i);
    const a = evaluateCycleHealth(i);
    const b = evaluateCycleHealth(i);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(i), frozen, "input must not be mutated");
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────

describe("alert deduplication", () => {
  const f = (code: string, subject: string) => ({ code, subject, detail: "d", severity: "ALERT" as const });

  test("a new condition notifies immediately", () => {
    const r = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    assert.equal(r.notify.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  test("an unchanged condition is suppressed on the next tick", () => {
    const s1 = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    const s2 = dedupeAlerts({ findings: [f("A", "x")], state: s1.nextState,
      now: new Date(NOW.getTime() + 60_000) });
    assert.equal(s2.notify.length, 0);
    assert.equal(s2.suppressed.length, 1);
  });

  test("100 ticks of an unchanged condition send exactly ONE alert", () => {
    // The defect this replaces: every tick sent the full finding list forever.
    let state = newAlertState();
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      const r = dedupeAlerts({ findings: [f("A", "x")], state,
        now: new Date(NOW.getTime() + i * 60_000) }); // 100 minutes
      sent += r.notify.length;
      state = r.nextState;
    }
    assert.equal(sent, 1);
  });

  test("a persistent condition reminds after the re-notify interval", () => {
    const s1 = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    const later = new Date(NOW.getTime() + RENOTIFY_AFTER_MS + 1000);
    const s2 = dedupeAlerts({ findings: [f("A", "x")], state: s1.nextState, now: later });
    assert.equal(s2.notify.length, 1, "must resurface, not go silent forever");
  });

  test("the reminder interval is shorter than the gap between publication slots", () => {
    assert.ok(RENOTIFY_AFTER_MS < 48 * 60 * 60 * 1000);
  });

  test("a cleared condition notifies once as resolved, then is forgotten", () => {
    const s1 = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    const s2 = dedupeAlerts({ findings: [], state: s1.nextState, now: NOW });
    assert.deepEqual(s2.resolved.map((r) => r.code), ["A"]);
    assert.equal(s2.nextState.size, 0, "resolved identities must not linger");

    const s3 = dedupeAlerts({ findings: [], state: s2.nextState, now: NOW });
    assert.deepEqual(s3.resolved, [], "resolution must not repeat");
  });

  test("a condition that returns after clearing notifies immediately again", () => {
    let s = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    s = dedupeAlerts({ findings: [], state: s.nextState, now: NOW });
    const back = dedupeAlerts({ findings: [f("A", "x")], state: s.nextState, now: NOW });
    assert.equal(back.notify.length, 1);
  });

  test("different subjects under one code are tracked separately", () => {
    const s1 = dedupeAlerts({ findings: [f("A", "x")], state: newAlertState(), now: NOW });
    const s2 = dedupeAlerts({ findings: [f("A", "x"), f("A", "y")], state: s1.nextState, now: NOW });
    assert.deepEqual(s2.notify.map((n) => n.subject), ["y"]);
  });

  test("a duplicate identity within one finding list is collapsed", () => {
    const r = dedupeAlerts({ findings: [f("A", "x"), f("A", "x")],
      state: newAlertState(), now: NOW });
    assert.equal(r.notify.length, 1);
    assert.equal(r.suppressed.length, 1);
  });

  test("identities survive a subject containing the key separator", () => {
    const weird = { code: "A", subject: "a b c", detail: "d", severity: "ALERT" as const };
    const s1 = dedupeAlerts({ findings: [weird], state: newAlertState(), now: NOW });
    const s2 = dedupeAlerts({ findings: [], state: s1.nextState, now: NOW });
    assert.deepEqual(s2.resolved, [{ code: "A", subject: "a b c" }]);
  });

  test("dedupe is pure — the input state is not mutated", () => {
    const state = newAlertState();
    dedupeAlerts({ findings: [f("A", "x")], state, now: NOW });
    assert.equal(state.size, 0);
  });

  test("resolution notices name what cleared", () => {
    assert.match(formatResolved(AI, [{ code: "A", subject: "x" }]), /RESOLVED A — x/);
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────

describe("health tick wiring", () => {
  const TICK = readFileSync("packages/monitor/src/healthTick.ts", "utf8");

  test("every finding is still logged even when the alert is suppressed", () => {
    const logAt = TICK.indexOf("deps.log(`[monitor:health] ${f.severity}");
    const dedupAt = TICK.indexOf("dedupeAlerts({");
    assert.ok(logAt >= 0 && dedupAt > logAt,
      "logs are the audit trail and must precede deduplication");
  });

  test("alert state is carried across ticks by the loop", () => {
    assert.match(TICK, /let alertState: AlertState = newAlertState\(\)/);
    assert.match(TICK, /alertState = r\.alertState/);
  });

  test("the dedup module is pure — it imports nothing", () => {
    const src = readFileSync("packages/monitor/src/lib/alertDedup.ts", "utf8");
    assert.deepEqual([...src.matchAll(/from "(.*?)"/g)].map((m) => m[1]), []);
  });
});
