/**
 * The authorization plane for unattended ordinary production.
 *
 *   npx tsx scripts/production-cycle-control.ts --check --channel ai-doom-scroll
 *   npx tsx scripts/production-cycle-control.ts --authorize --channel wet-circuit \
 *       --i-understand-this-authorizes-one-unattended-video
 *   npx tsx scripts/production-cycle-control.ts --verify --channel ai-doom-scroll --cycle <id>
 *
 * Unattended production inverts where the authorization lives. Guarded manual
 * production (ordinary-production-control.ts) is authorized by the act of a
 * human running it; an unattended container has no such act, so a container
 * start would otherwise BE the authorization — and a redeploy, a restart or an
 * infrastructure event would each make a video. The durable ProductionCycle row
 * is what a start is checked against, and this tool is the only thing that
 * writes one.
 *
 * One authorization is one video. Authorizing is idempotent per publication
 * slot, so running this twice for the same slot does not buy a second video; it
 * returns the existing cycle. That is deliberate — a fat-fingered repeat should
 * be a no-op, not an extra upload.
 *
 * LOCAL ONLY. No runtime imports this, and nothing here runs a pipeline.
 */
import {
  disconnect,
  authorizeCycle, currentRunnableCycle, listCycles, getCycle,
  nextCycleSlot, assertValidSlot, describeSlot,
  isClaimStale, unattendedClaimantId, CLAIM_STALE_AFTER_MS,
  inspectStaleCycle, failAbandonedCycle,
  CycleError,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";
export const CHANNELS: ChannelKey[] = ["ai-doom-scroll", "wet-circuit"];

/** The phrase that must be typed to write an authorization. */
export const AUTHORIZE_ACK = "--i-understand-this-authorizes-one-unattended-video";

/**
 * The phrase that must be typed to terminalise an abandoned cycle.
 *
 * Distinct from the authorize phrase on purpose: these are opposite actions and
 * a single blanket "--yes" would let muscle memory from one reach the other.
 */
export const REAP_ACK = "--i-understand-this-terminates-an-abandoned-cycle";

// ── Injected surface (so the decisions below are testable without a DB) ────

export interface CycleDeps {
  authorize(channel: string, slot: Date): Promise<{ cycle: ProductionCycle; created: boolean }>;
  runnable(channel: string, now: Date): Promise<ProductionCycle | null>;
  list(channel: string, limit: number): Promise<ProductionCycle[]>;
  read(cycleId: string): Promise<ProductionCycle | null>;
  nextSlot(channel: string, now: Date): Promise<Date>;
}

export function realDeps(): CycleDeps {
  return {
    authorize: authorizeCycle,
    runnable: currentRunnableCycle,
    list: listCycles,
    read: getCycle,
    nextSlot: nextCycleSlot,
  };
}

// ── CHECK ─────────────────────────────────────────────────────────────────

export interface CheckResult {
  channel: string;
  runnable: ProductionCycle | null;
  stale: boolean;
  needsAttention: ProductionCycle[];
  nextSlot: Date;
  recent: ProductionCycle[];
}

/**
 * Read-only state of a channel's authorizations.
 *
 * `needsAttention` is the part worth reading first: RECONCILIATION_REQUIRED
 * cycles, and CLAIMED cycles that have sat untouched past the stale threshold.
 * Neither is fixed here — a stale claim is reported, never stolen, because the
 * only safe way to release one is for a human to establish that the claiming
 * container is genuinely gone.
 */
export async function doCheck(
  deps: CycleDeps, channel: ChannelKey, now = new Date(),
): Promise<CheckResult> {
  const runnable = await deps.runnable(channel, now);
  const recent = await deps.list(channel, 10);
  const needsAttention = recent.filter(
    (c) => c.status === "RECONCILIATION_REQUIRED" || isClaimStale(c, now),
  );
  return {
    channel,
    runnable,
    stale: runnable ? isClaimStale(runnable, now) : false,
    needsAttention,
    nextSlot: await deps.nextSlot(channel, now),
    recent,
  };
}

// ── AUTHORIZE ─────────────────────────────────────────────────────────────

export interface AuthorizeResult {
  outcome: "AUTHORIZED" | "ALREADY_AUTHORIZED" | "REFUSED";
  reason: string;
  cycle: ProductionCycle | null;
}

/**
 * Write exactly one authorization.
 *
 * Refuses while an earlier cycle is still runnable. Two open cycles for one
 * channel would mean two containers could each find work, and the whole point
 * of the mechanism is that at most one video is ever owed at a time.
 */
export async function doAuthorize(
  deps: CycleDeps, channel: ChannelKey, acknowledged: boolean,
  now = new Date(), explicitSlot?: Date,
): Promise<AuthorizeResult> {
  if (!acknowledged) {
    return { outcome: "REFUSED", cycle: null,
      reason: `refused: ${AUTHORIZE_ACK} was not passed` };
  }

  const open = await deps.runnable(channel, now);
  if (open) {
    return { outcome: "REFUSED", cycle: open,
      reason: `refused: cycle ${open.id} is still ${open.status} for slot ` +
        `${open.targetPublishSlot.toISOString()} — one open cycle at a time` };
  }

  let slot: Date;
  if (explicitSlot) {
    try {
      assertValidSlot(explicitSlot, channel);
    } catch (err) {
      const code = err instanceof CycleError ? err.code : "CYCLE_SLOT_INVALID";
      return { outcome: "REFUSED", cycle: null,
        reason: `refused [${code}]: ${err instanceof Error ? err.message : String(err)}` };
    }
    slot = explicitSlot;
  } else {
    slot = await deps.nextSlot(channel, now);
  }

  const { cycle, created } = await deps.authorize(channel, slot);
  return {
    outcome: created ? "AUTHORIZED" : "ALREADY_AUTHORIZED",
    cycle,
    reason: created
      ? `authorized one video for ${describeSlot(slot)}`
      : `slot ${describeSlot(slot)} was already authorized as ${cycle.id} — no second video bought`,
  };
}

// ── VERIFY ────────────────────────────────────────────────────────────────

export interface VerifyResult {
  consistent: boolean;
  cycle: ProductionCycle | null;
  problems: string[];
}

/**
 * Check one cycle's row against the invariants it is supposed to hold.
 *
 * Pure inspection of the durable record — it does not touch the pipeline, and a
 * problem here is a report, not a repair.
 */
export async function doVerify(
  deps: CycleDeps, channel: ChannelKey, cycleId: string, now = new Date(),
): Promise<VerifyResult> {
  const cycle = await deps.read(cycleId);
  if (!cycle) return { consistent: false, cycle: null, problems: [`no cycle ${cycleId}`] };

  const problems: string[] = [];
  if (cycle.channel !== channel) {
    problems.push(`cycle belongs to ${cycle.channel}, not ${channel}`);
  }
  try {
    assertValidSlot(cycle.targetPublishSlot, channel);
  } catch (err) {
    problems.push(`target slot invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cycle.status === "COMPLETED" && !cycle.videoId) {
    problems.push("COMPLETED without a video — nothing was produced under this authorization");
  }
  if (cycle.status === "AUTHORIZED" && cycle.videoId) {
    problems.push("AUTHORIZED but already carries a video — claim state was lost");
  }
  if (cycle.claimantId && cycle.claimantId !== unattendedClaimantId(channel)) {
    problems.push(`claimed by ${cycle.claimantId}, not the unattended runner ` +
      `${unattendedClaimantId(channel)}`);
  }
  if (isClaimStale(cycle, now)) {
    problems.push(`CLAIMED since ${cycle.claimedAt?.toISOString()} — past the ` +
      `${CLAIM_STALE_AFTER_MS / 60000}min stale threshold; confirm the container is gone`);
  }
  if (cycle.status === "RECONCILIATION_REQUIRED") {
    problems.push(`held for reconciliation (${cycle.failureCode ?? "no code"}) — ` +
      "confirm on YouTube what actually exists before authorizing anything further");
  }
  return { consistent: problems.length === 0, cycle, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fmt(c: ProductionCycle): string {
  return `  ${c.id}\n    slot ${c.targetPublishSlot.toISOString()}  status ${c.status}` +
    `\n    claimant ${c.claimantId ?? "—"}  video ${c.videoId ?? "—"}` +
    (c.failureCode ? `\n    failure ${c.failureCode}` : "");
}

export async function main(): Promise<void> {
  const channel = argValue(process.argv, "--channel") as ChannelKey | undefined;
  if (!channel || !CHANNELS.includes(channel)) {
    console.error(`✗ --channel must be one of ${CHANNELS.join(" | ")}`);
    process.exitCode = 2; return;
  }
  const deps = realDeps();

  // Modes are explicit. CHECK remains the default, but an unrecognised flag
  // must not silently BECOME check — a typo'd "--reep" should refuse, not
  // quietly print a report and look like it worked.
  const MODES = ["--check", "--authorize", "--verify", "--inspect-stale", "--reap"];
  const unknown = process.argv.slice(2).filter(
    (a) => a.startsWith("--") && !MODES.includes(a) &&
      !["--channel", "--cycle", "--slot", AUTHORIZE_ACK, REAP_ACK].includes(a));
  if (unknown.length) {
    console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
    console.error(`  modes: ${MODES.join(" | ")}`);
    process.exitCode = 2; return;
  }

  if (process.argv.includes("--authorize")) {
    const slotArg = argValue(process.argv, "--slot");
    const r = await doAuthorize(
      deps, channel, process.argv.includes(AUTHORIZE_ACK),
      new Date(), slotArg ? new Date(slotArg) : undefined,
    );
    console.log(`\n  OUTCOME : ${r.outcome}\n  reason  : ${r.reason}`);
    if (r.cycle) console.log(fmt(r.cycle));
    if (r.outcome === "REFUSED") process.exitCode = 1;
    return;
  }

  if (process.argv.includes("--inspect-stale") || process.argv.includes("--reap")) {
    const id = argValue(process.argv, "--cycle");
    if (!id) { console.error("✗ --cycle <id> is required"); process.exitCode = 2; return; }
    const reap = process.argv.includes("--reap");
    if (!reap) {
      const a = await inspectStaleCycle(channel, id);
      console.log(`\n  DISPOSITION : ${a.disposition}`);
      if (a.cycle) console.log(fmt(a.cycle));
      for (const r of a.reasons) console.log(`  · ${r}`);
      console.log(`  side effects: video=${a.sideEffects.videoId ?? "—"} ` +
        `youtube=${a.sideEffects.youtubeId ?? "—"} ` +
        `unresolvedIntents=${a.sideEffects.unresolvedIntents} ` +
        `narrationChars=${a.sideEffects.narrationCharges}`);
      return;
    }
    const r = await failAbandonedCycle(channel, id, process.argv.includes(REAP_ACK));
    console.log(`\n  ACTED   : ${r.acted ? "yes" : "no"}`);
    console.log(`  status  : ${r.newStatus ?? "unchanged"}`);
    console.log(`  reason  : ${r.reason}`);
    for (const x of r.assessment.reasons) console.log(`  · ${x}`);
    if (!r.acted) process.exitCode = 1;
    return;
  }

  if (process.argv.includes("--verify")) {
    const id = argValue(process.argv, "--cycle");
    if (!id) { console.error("✗ --cycle <id> is required for --verify"); process.exitCode = 2; return; }
    const r = await doVerify(deps, channel, id);
    console.log(`\n  CONSISTENT : ${r.consistent ? "yes" : "NO"}`);
    if (r.cycle) console.log(fmt(r.cycle));
    for (const p of r.problems) console.log(`  ✗ ${p}`);
    if (!r.consistent) process.exitCode = 1;
    return;
  }

  const r = await doCheck(deps, channel);
  console.log(`\n  CHANNEL   : ${r.channel}`);
  console.log(`  runnable  : ${r.runnable ? "yes" : "no — a container start would do nothing"}`);
  if (r.runnable) console.log(fmt(r.runnable));
  console.log(`  next slot : ${describeSlot(r.nextSlot)}`);
  if (r.needsAttention.length) {
    console.log(`\n  ⚠ ${r.needsAttention.length} cycle(s) need a human:`);
    for (const c of r.needsAttention) console.log(fmt(c));
  }
  console.log(`\n  recent (${r.recent.length}):`);
  for (const c of r.recent) console.log(fmt(c));
}

const isDirectRun =
  process.argv[1]?.endsWith("production-cycle-control.ts") ||
  process.argv[1]?.endsWith("production-cycle-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
