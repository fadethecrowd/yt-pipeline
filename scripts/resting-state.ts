/**
 * One command that answers "is anything running, and can anything spend?".
 *
 *   npx tsx scripts/resting-state.ts
 *
 * Read-only. Every number comes from the same durable source the controls use,
 * so it cannot disagree with them, and the next publication slot comes from the
 * canonical scheduler rather than a restatement of the cadence.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  prisma, disconnect, activeLeaseFor, trancheReport, nextPublishSlot, describeSlot,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll";

async function railwayVar(service: string, key: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(
      "railway", ["variables", "--service", service, "--json"], { maxBuffer: 8 * 1024 * 1024 });
    const v = JSON.parse(stdout) as Record<string, string>;
    return key in v ? v[key]! : "<absent>";
  } catch { return "<unreadable>"; }
}

async function main(): Promise<void> {
  const t = await trancheReport(CHANNEL);
  const budgets = await prisma.creditBudget.findMany({ where: { testStage: "PRODUCTION" } });
  const activeRuns = await prisma.pipelineRun.count({ where: { endTime: null } });
  const intents = await prisma.uploadIntent.count({
    where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } } });
  const cycles = await (prisma as never as { productionCycle: { count(): Promise<number> } })
    .productionCycle.count();
  const leases = await (prisma as never as { supervisedLease: { count(a: unknown): Promise<number> } })
    .supervisedLease.count({ where: { status: "ACTIVE" } });

  const now = new Date();
  const scheduled = await prisma.video.findMany({
    where: { scheduledAt: { gt: now } }, select: { youtubeId: true, scheduledAt: true } });
  const occupied = scheduled.map((v) => v.scheduledAt!).filter(Boolean);

  console.log("\n══ RESTING STATE — ai-doom-scroll ══\n");
  console.log(`  tranche            : ${t.phase}` +
    (t.tranche ? ` — ${t.tranche.consumedCandidates}/${t.tranche.maxCandidates} consumed, ` +
      `${t.remaining} remaining, Shorts ${t.tranche.shortsEnabled ? "ON" : "off"}, ` +
      `expires ${t.tranche.expiresAt.toISOString()}` : ""));
  for (const b of budgets) {
    console.log(`  budget ${b.channel}/PRODUCTION`.padEnd(38) +
      `limit=${b.limitChars} reserved=${b.reservedChars} charged=${b.chargedChars}`);
  }
  console.log(`  DISABLE_ELEVEN     : ${await railwayVar("yt-pipeline", "DISABLE_ELEVEN")}`);
  console.log(`  PIPELINE_MODE      : ${await railwayVar("yt-pipeline", "PIPELINE_MODE")}`);
  console.log(`  MONITOR_MODE       : ${await railwayVar("monitor-ai-doom", "MONITOR_MODE")}`);
  console.log(`  active runs        : ${activeRuns}`);
  console.log(`  unresolved intents : ${intents}`);
  console.log(`  production cycles  : ${cycles}`);
  console.log(`  supervised leases  : ${leases}`);
  for (const ch of [CHANNEL, "wet-circuit"]) {
    console.log(`  lease ${ch}`.padEnd(38) + `: ${(await activeLeaseFor(ch)) ? "LIVE" : "none"}`);
  }
  console.log(`  staged inventory   : ${scheduled.length}`);
  for (const v of scheduled) console.log(`      ${v.youtubeId} @ ${v.scheduledAt?.toISOString()}`);
  try {
    console.log(`  next free slot     : ${describeSlot(nextPublishSlot(now, { occupied }))}`);
  } catch (err) {
    console.log(`  next free slot     : unavailable — ${err instanceof Error ? err.message : err}`);
  }
  console.log("");
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
