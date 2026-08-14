/**
 * Authorize a finite amount of ordinary production spend.
 *
 *   npx tsx scripts/production-tranche-control.ts --channel ai-doom-scroll
 *   npx tsx scripts/production-tranche-control.ts --channel ai-doom-scroll \
 *     --authorize --count 1 --i-understand-this-authorizes-real-production-spend
 *   npx tsx scripts/production-tranche-control.ts --channel ai-doom-scroll --close
 *   npx tsx scripts/production-tranche-control.ts --reconcile
 *
 * Graduation proves a channel is allowed to enter production. It grants no
 * money. This is what grants money, and only ever a bounded, expiring amount:
 * N candidate attempts, until a deadline, after which the channel is
 * financially inert again with nobody having to remember to switch it off.
 *
 * DELIBERATELY SEPARATE from `ordinary-production-control.ts --run`. If making
 * a video also granted permission to make a video, the permission would be
 * decorative. A human authorizes; a later, different invocation spends.
 *
 * CHECK is read-only. AUTHORIZE writes one row and starts nothing: it creates
 * no candidate, calls no API, touches no Railway variable, and opens no budget.
 * The controlled standing budget stays at zero throughout — a tranche permits a
 * candidate to REQUEST its own bounded window, it does not pre-fund one.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  prisma, disconnect, trancheReport, authorizeTranche, closeTranche,
  reconcileTranches, remainingCandidates, budgetReport,
  TRANCHE_MAX_CANDIDATES, TRANCHE_DEFAULT_LIFETIME_MS, TRANCHE_MAX_LIFETIME_MS,
} from "@yt-pipeline/pipeline-core";
import { SPECS } from "./channel-graduation-control";
import type { ChannelKey } from "./channel-graduation-control";
import "dotenv/config";

const CONFIRM = "--i-understand-this-authorizes-real-production-spend";

export function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

export function assertKnownFlags(argv: string[], known: string[]): boolean {
  const unknown = argv.slice(2).filter((a) => a.startsWith("--") && !known.includes(a));
  if (unknown.length === 0) return true;
  console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
  console.error(`  known flags: ${known.join(" ")}`);
  process.exitCode = 2;
  return false;
}

/** Refuses to guess. Two mode flags is an operator error, not a precedence puzzle. */
export function selectedMode(argv: string[]): "AUTHORIZE" | "CLOSE" | "RECONCILE" | "CHECK" | "AMBIGUOUS" {
  const picked = [
    argv.includes("--authorize") && "AUTHORIZE",
    argv.includes("--close") && "CLOSE",
    argv.includes("--reconcile") && "RECONCILE",
  ].filter(Boolean) as string[];
  if (picked.length > 1) return "AMBIGUOUS";
  return (picked[0] as never) ?? "CHECK";
}

async function report(channel: ChannelKey): Promise<void> {
  const r = await trancheReport(channel);
  console.log(`── PRODUCTION TRANCHE — ${channel}`);
  if (!r.tranche) {
    console.log("   no authorization exists");
    console.log("   PHASE          : NO_AUTHORIZATION");
    console.log("   → production cannot spend. This is the normal resting state.");
    return;
  }
  const t = r.tranche;
  console.log(`   tranche        : ${t.id}`);
  console.log(`   authorized by  : ${t.authorizedBy}`);
  console.log(`   commit         : ${t.policyCommit ?? "n/a"}`);
  console.log(`   candidates     : ${t.consumedCandidates}/${t.maxCandidates} consumed, ` +
    `${remainingCandidates(t)} remaining`);
  console.log(`   Shorts         : ${t.shortsEnabled ? "ENABLED" : "disabled"}`);
  console.log(`   long-form      : enabled (always)`);
  console.log(`   authorizedAt   : ${t.authorizedAt.toISOString()}`);
  console.log(`   expiresAt      : ${t.expiresAt.toISOString()}`);
  console.log(`   status         : ${t.status}${t.closedReason ? ` (${t.closedReason})` : ""}`);
  for (const s of r.slots) {
    console.log(`   slot #${s.slotIndex}       : ${s.status}  candidate ${s.videoId}  run ${s.runId}` +
      `${s.outcome ? `  — ${s.outcome}` : ""}`);
  }
  console.log(`   live           : ${r.live ? "yes" : "no"} — ${r.reason}`);
  console.log(`   PHASE          : ${r.phase}`);
}

async function main(): Promise<void> {
  const known = ["--authorize", "--channel", "--close", "--count", "--hours", "--reconcile",
    "--shorts", CONFIRM];
  if (!assertKnownFlags(process.argv, known)) return;

  const mode = selectedMode(process.argv);
  if (mode === "AMBIGUOUS") {
    console.error("✗ more than one mode flag given — refusing to guess");
    process.exitCode = 2;
    return;
  }

  if (mode === "RECONCILE") {
    const closed = await reconcileTranches();
    console.log(`── TRANCHE RECONCILER`);
    for (const c of closed) console.log(`   ${c.channel} ${c.id} → ${c.status} (${c.reason})`);
    console.log(`   RECONCILER = ${closed.length === 0 ? "CLEAN" : "RECOVERED"} ` +
      `(${closed.length} tranche(s) retired)`);
    return;
  }

  const channel = argValue(process.argv, "--channel") as ChannelKey | null;
  if (!channel || !(channel in SPECS)) {
    console.error(`✗ --channel must be one of: ${Object.keys(SPECS).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  if (mode === "CHECK") { await report(channel); return; }

  if (mode === "CLOSE") {
    const r = await trancheReport(channel);
    if (!r.tranche) { console.error("✗ nothing to close"); process.exitCode = 1; return; }
    const ok = await closeTranche(r.tranche.id, "closed by operator");
    console.log(ok ? `   ✓ tranche ${r.tranche.id} CLOSED` : "   ✗ close matched no row");
    if (!ok) process.exitCode = 1;
    await report(channel);
    return;
  }

  // ── AUTHORIZE ─────────────────────────────────────────────────────
  if (!process.argv.includes(CONFIRM)) {
    console.error(`✗ --authorize requires ${CONFIRM}. Refusing.`);
    process.exitCode = 2;
    return;
  }
  const rawCount = argValue(process.argv, "--count");
  const count = Number(rawCount);
  if (rawCount === null || !Number.isFinite(count)) {
    console.error(`✗ --count is required and must be a finite integer (1..${TRANCHE_MAX_CANDIDATES})`);
    process.exitCode = 2;
    return;
  }
  const rawHours = argValue(process.argv, "--hours");
  const lifetimeMs = rawHours === null
    ? TRANCHE_DEFAULT_LIFETIME_MS
    : Number(rawHours) * 3600_000;
  if (rawHours !== null && (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0)) {
    console.error("✗ --hours must be a positive finite number");
    process.exitCode = 2;
    return;
  }

  // Graduation is read from the durable pilot row, never asserted by a flag.
  const spec = SPECS[channel];
  const pilot = await (prisma as never as { productionPilot: any })
    .productionPilot.findUnique({ where: { pilotId: spec.pilotId } });
  const graduated = !!pilot && pilot.status === "COMPLETED"
    && pilot.channel === channel
    && pilot.successCount === spec.qualificationTarget
    && pilot.successVideoIds.length === spec.qualificationTarget;

  // The standing budget must be zero BEFORE a tranche exists, or the tranche is
  // not the thing authorising the spend.
  const rep = await budgetReport();
  const nonZero = (rep.rows as { channel: string; stage: string; limit: number }[])
    .filter((r) => r.stage !== "DIAGNOSTIC" && r.limit !== 0);
  if (nonZero.length > 0) {
    console.error(`✗ controlled budgets are not at zero: ` +
      nonZero.map((r) => `${r.channel}/${r.stage}=${r.limit}`).join(" "));
    process.exitCode = 1;
    return;
  }

  const commit = (() => {
    try {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch { return null; }
  })();

  const r = await authorizeTranche({
    channel: channel as never,
    count,
    graduated,
    authorizedBy: `operator via ${CONFIRM}`,
    shortsEnabled: process.argv.includes("--shorts"),
    policyCommit: commit,
    lifetimeMs,
  });
  if (!r.ok) {
    console.error(`✗ authorize refused: ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`   ✓ authorized ${count} candidate attempt(s) for ${channel}`);
  console.log(`     expires ${r.tranche.expiresAt.toISOString()} ` +
    `(max ${TRANCHE_MAX_LIFETIME_MS / 3600_000}h)`);
  console.log(`     Shorts ${r.tranche.shortsEnabled ? "ENABLED" : "disabled"}`);
  console.log(`     nothing has started — RUN is a separate invocation`);
  await report(channel);
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => void disconnect());
}
