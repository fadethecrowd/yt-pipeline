/**
 * A full unattended-production lifecycle, end to end, touching nothing real.
 *
 *   npx tsx scripts/synthetic-canary.ts
 *   npx tsx scripts/synthetic-canary.ts --json
 *
 * Run this after every release. The unit tests prove each piece in isolation;
 * this proves the pieces still fit together — scheduler policy feeding slot
 * calculation feeding the cycle state machine feeding claim, bind, settle — in
 * the order a real day would exercise them.
 *
 * NOTHING REAL IS TOUCHED. It opens no database connection, creates no
 * ProductionCycle, no candidate, spends no credits, renders nothing and calls
 * no YouTube API. The cycle table is modelled in memory with the same
 * compare-and-set guards the SQL uses; those guards are pinned against the real
 * statements by tests/production-cycle.test.ts and tests/unattended-runtime.test.ts.
 *
 * The clock is fixed, so the run is deterministic and a failure is always
 * reproducible.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  schedulerTick, assertValidSlot, publicationPolicyFor, nextPublishSlot,
  isAmbiguousFailure, unattendedClaimantId, describeSlot,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS, CLAIM_STALE_AFTER_MS,
  evaluateCycleHealth,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, SchedulerDeps } from "@yt-pipeline/pipeline-core";

export type Channel = "ai-doom-scroll" | "wet-circuit";
const CHANNELS: Channel[] = ["ai-doom-scroll", "wet-circuit"];

/** A Monday. Fixed so the whole run is deterministic. */
const MONDAY_SLOT = new Date("2026-08-10T19:00:00.000Z");

/** In-memory cycle table carrying the same guards as the SQL. */
class World {
  rows: ProductionCycle[] = [];
  videos: { id: string; cycleId: string }[] = [];
  private seq = 0;

  authorize(channel: string, slot: Date): { cycle: ProductionCycle; created: boolean } {
    const existing = this.rows.find(
      (r) => r.channel === channel && r.targetPublishSlot.getTime() === slot.getTime());
    if (existing) return { cycle: existing, created: false };   // unique index
    const cycle: ProductionCycle = {
      id: `cyc-${++this.seq}`, channel, targetPublishSlot: slot, status: "AUTHORIZED",
      claimantId: null, videoId: null, pipelineRunId: null, failureCode: null,
      authorizedAt: new Date(), claimedAt: null, completedAt: null, failedAt: null,
    };
    this.rows.push(cycle);
    return { cycle, created: true };
  }

  runnable(channel: string, now: Date): ProductionCycle | null {
    return this.rows.filter((r) => r.channel === channel &&
      (r.status === "AUTHORIZED" || r.status === "CLAIMED") &&
      r.targetPublishSlot.getTime() > now.getTime())
      .sort((a, b) => a.targetPublishSlot.getTime() - b.targetPublishSlot.getTime())[0] ?? null;
  }

  claim(id: string, claimant: string, at: Date): ProductionCycle | null {
    const r = this.rows.find((x) => x.id === id);
    if (!r || (r.status !== "AUTHORIZED" && r.status !== "CLAIMED")) return null;
    if (r.claimantId !== null && r.claimantId !== claimant) return null;
    r.status = "CLAIMED"; r.claimantId = claimant; r.claimedAt = r.claimedAt ?? at;
    return r;
  }

  createAndAttach(id: string, claimant: string, videoId: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || r.videoId !== null) return false;
    this.videos.push({ id: videoId, cycleId: id });
    r.videoId = videoId;
    return true;
  }

  complete(id: string, claimant: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || !r.videoId) return false;
    r.status = "COMPLETED"; r.completedAt = new Date(); return true;
  }

  fail(id: string, claimant: string, stage: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED") return false;
    r.status = isAmbiguousFailure(stage) ? "RECONCILIATION_REQUIRED" : "FAILED";
    r.failureCode = stage; r.failedAt = new Date(); return true;
  }

  deps(slot: Date): SchedulerDeps {
    return {
      nextSlot: async () => slot,
      validate: assertValidSlot,
      runnable: async (c, n) => this.runnable(c, n),
      authorize: async (c, s) => this.authorize(c, s),
    };
  }
}

interface Step { name: string; ok: boolean; detail: string }

function check(steps: Step[], name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
}

/** One channel's full day, in the order it would really happen. */
async function runChannel(channel: Channel): Promise<Step[]> {
  const steps: Step[] = [];
  const w = new World();
  const claimant = unattendedClaimantId(channel);
  const ON = { SCHEDULER_ENABLED: "true" } as NodeJS.ProcessEnv;

  // 1. Publication policy resolves and the slot it produces is valid.
  const policy = publicationPolicyFor(channel);
  const computed = nextPublishSlot(new Date("2026-08-09T12:00:00Z"),
    { days: policy.days, hour: policy.hour, minute: policy.minute, timeZone: policy.timeZone });
  let slotValid = true;
  try { assertValidSlot(computed, channel); } catch { slotValid = false; }
  check(steps, "policy → slot", slotValid && computed.getTime() === MONDAY_SLOT.getTime(),
    describeSlot(computed));

  // 2. Too early: the scheduler declines and writes nothing.
  const early = new Date(MONDAY_SLOT.getTime() - AUTHORIZATION_LEAD_MS - 3600_000);
  const t0 = await schedulerTick(channel, w.deps(MONDAY_SLOT), { now: early, env: ON });
  check(steps, "scheduler declines outside lead window",
    t0.outcome === "SKIPPED_TOO_EARLY" && w.rows.length === 0, t0.outcome);

  // 3. Disabled: still writes nothing, even inside the window.
  const inWindow = new Date(MONDAY_SLOT.getTime() - 5 * 3600_000);
  const tOff = await schedulerTick(channel, w.deps(MONDAY_SLOT), { now: inWindow, env: {} });
  check(steps, "disabled scheduler writes nothing",
    tOff.outcome === "SKIPPED_DISABLED" && w.rows.length === 0, tOff.outcome);

  // 4. In window and armed: exactly one authorization.
  const t1 = await schedulerTick(channel, w.deps(MONDAY_SLOT), { now: inWindow, env: ON });
  check(steps, "authorizes one cycle in window",
    t1.outcome === "AUTHORIZED" && w.rows.length === 1, t1.outcome);

  // 5. A tick storm buys nothing more.
  for (let i = 0; i < 25; i++) {
    await schedulerTick(channel, w.deps(MONDAY_SLOT), { now: inWindow, env: ON });
  }
  check(steps, "25-tick storm adds no inventory", w.rows.length === 1, `${w.rows.length} cycle(s)`);

  const cycle = w.rows[0];

  // 6. Container starts, claims, binds its one candidate.
  const claimed = w.claim(cycle.id, claimant, inWindow);
  const bound = w.createAndAttach(cycle.id, claimant, "synthetic-video-1");
  check(steps, "claim and bind one candidate",
    !!claimed && bound && w.videos.length === 1, `videos=${w.videos.length}`);

  // 7. Crash and restart: the stable claimant resumes the SAME candidate.
  const resumed = w.claim(cycle.id, unattendedClaimantId(channel), inWindow);
  check(steps, "restart resumes the same candidate, creates no second",
    resumed?.videoId === "synthetic-video-1" && w.videos.length === 1,
    `videoId=${resumed?.videoId} videos=${w.videos.length}`);

  // 8. A foreign claimant is refused.
  check(steps, "foreign claimant refused",
    w.claim(cycle.id, "someone-else", inWindow) === null, "null");

  // 9. A second bind attempt is refused and creates nothing.
  const second = w.createAndAttach(cycle.id, claimant, "synthetic-video-2");
  check(steps, "second candidate refused",
    !second && w.videos.length === 1, `videos=${w.videos.length}`);

  // 10. Health sees nothing wrong mid-flight.
  const mid = evaluateCycleHealth({
    channel, cycles: w.rows, recentSlots: [], scheduledSlotInstants: [],
    schedulerEnabled: true, unattendedEnabled: true, now: inWindow });
  check(steps, "health quiet during a normal run", mid.findings.length === 0,
    `${mid.findings.length} finding(s)`);

  // 11. Completion, then further starts find nothing.
  check(steps, "cycle completes", w.complete(cycle.id, claimant), cycle.status);
  const after = await schedulerTick(channel, w.deps(MONDAY_SLOT), { now: inWindow, env: ON });
  check(steps, "completed cycle is never re-run",
    w.runnable(channel, inWindow) === null && after.outcome === "ALREADY_AUTHORIZED",
    after.outcome);

  // 12. A stale claim is detected by health, not silently ignored.
  const w2 = new World();
  const { cycle: c2 } = w2.authorize(channel, MONDAY_SLOT);
  w2.claim(c2.id, claimant, new Date(inWindow.getTime() - CLAIM_STALE_AFTER_MS - 60_000));
  const stale = evaluateCycleHealth({
    channel, cycles: w2.rows, recentSlots: [], scheduledSlotInstants: [],
    schedulerEnabled: true, unattendedEnabled: true, now: inWindow });
  check(steps, "stale claim is detected",
    stale.findings.some((f) => f.code === "CYCLE_CLAIM_STALE"),
    stale.findings.map((f) => f.code).join(",") || "none");

  // 13. An ambiguous upload parks for reconciliation and never re-runs.
  const w3 = new World();
  const { cycle: c3 } = w3.authorize(channel, MONDAY_SLOT);
  w3.claim(c3.id, claimant, inWindow);
  w3.createAndAttach(c3.id, claimant, "synthetic-video-3");
  w3.fail(c3.id, claimant, "youtubeUpload");
  check(steps, "ambiguous upload → RECONCILIATION_REQUIRED, never retried",
    c3.status === "RECONCILIATION_REQUIRED" && w3.runnable(channel, inWindow) === null,
    c3.status);

  // 14. A pre-upload failure is an ordinary FAILED, also never retried.
  const w4 = new World();
  const { cycle: c4 } = w4.authorize(channel, MONDAY_SLOT);
  w4.claim(c4.id, claimant, inWindow);
  w4.createAndAttach(c4.id, claimant, "synthetic-video-4");
  w4.fail(c4.id, claimant, "voiceover");
  check(steps, "pre-upload failure → FAILED, never retried",
    c4.status === "FAILED" && w4.runnable(channel, inWindow) === null, c4.status);

  // 15. Too late to start: the scheduler refuses rather than buying a rush job.
  const w5 = new World();
  const late = new Date(MONDAY_SLOT.getTime() - MINIMUM_LEAD_MS + 60_000);
  const tLate = await schedulerTick(channel, w5.deps(MONDAY_SLOT), { now: late, env: ON });
  check(steps, "declines too close to the slot",
    tLate.outcome === "SKIPPED_TOO_LATE" && w5.rows.length === 0, tLate.outcome);

  // 16. An invalid slot fails closed.
  const w6 = new World();
  const tuesday = new Date("2026-08-11T19:00:00.000Z");
  const tBad = await schedulerTick(channel, w6.deps(tuesday), { now: inWindow, env: ON });
  check(steps, "invalid slot fails closed",
    tBad.outcome === "SKIPPED_INVALID_SLOT" && w6.rows.length === 0, tBad.outcome);

  return steps;
}

export async function main(): Promise<void> {
  const KNOWN = ["--json"];
  const unknown = process.argv.slice(2).filter((a) => a.startsWith("--") && !KNOWN.includes(a));
  if (unknown.length) {
    console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
    process.exitCode = 2; return;
  }

  const results: { channel: string; steps: Step[] }[] = [];
  for (const c of CHANNELS) results.push({ channel: c, steps: await runChannel(c) });

  const failed = results.flatMap((r) => r.steps.filter((s) => !s.ok));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ results, passed: failed.length === 0 }, null, 2));
    if (failed.length) process.exitCode = 1;
    return;
  }

  console.log("\n══ SYNTHETIC CANARY — no database, no spend, no upload ══");
  for (const r of results) {
    console.log(`\n── ${r.channel} ──`);
    for (const s of r.steps) {
      console.log(`  ${s.ok ? "✓" : "✗"} ${s.name.padEnd(48)} ${s.detail}`);
    }
  }
  const total = results.reduce((a, r) => a + r.steps.length, 0);
  console.log(`\n  ${total - failed.length}/${total} steps passed`);
  console.log(`\n  SYNTHETIC_CANARY = ${failed.length === 0 ? "PASS" : "FAIL"}\n`);
  if (failed.length) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("synthetic-canary.ts") ||
  process.argv[1]?.endsWith("synthetic-canary.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CANARY FAILED:", e); process.exitCode = 1; });
}
