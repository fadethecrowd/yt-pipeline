/**
 * Quarantine stale jobs so a pipeline restart cannot auto-resume them.
 *
 *   npx tsx scripts/quarantine-stale-jobs.ts <videoId> [videoId...] --reason "..." [--wc]
 *   npx tsx scripts/quarantine-stale-jobs.ts --list
 *   npx tsx scripts/quarantine-stale-jobs.ts --release <videoId>
 *
 * Additive and reversible: the original status is recorded in job_quarantine
 * and can be written back with --release. Nothing is deleted, no render or
 * audio artifact is touched, and no generation is triggered.
 */
import { prisma, disconnect, quarantineJob, releaseQuarantine, resumableJobs } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

async function list() {
  const rows = await prisma.jobQuarantine.findMany({ orderBy: { createdAt: "desc" } });
  console.log(`\n${rows.length} quarantine record(s):`);
  for (const r of rows) {
    console.log(
      `  ${r.videoId}  ${r.channel}  ${r.originalStatus} → ${r.newStatus}  ` +
        `${r.createdAt.toISOString()}  by=${r.operator} via=${r.actionSource}` +
        (r.releasedAt ? `  RELEASED ${r.releasedAt.toISOString()} by ${r.releasedBy}` : ""),
    );
    console.log(`      reason: ${r.reason}`);
  }
  for (const ch of ["ai-doom-scroll", "wet-circuit"] as const) {
    const jobs = await resumableJobs(ch);
    console.log(
      `\n  ${ch}: ${jobs.length} job(s) a restart would resume` +
        (jobs.length ? ` → ${jobs.map((j) => `${j.id}(${j.status})`).join(", ")}` : ""),
    );
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    await list();
    await disconnect();
    return;
  }

  const relIdx = args.indexOf("--release");
  if (relIdx >= 0) {
    const id = args[relIdx + 1];
    const r = await releaseQuarantine(id, process.env.USER ?? "operator");
    console.log(`released ${r.videoId} → restored to ${r.originalStatus}`);
    await disconnect();
    return;
  }

  const reasonIdx = args.indexOf("--reason");
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : "stale job — operator quarantine";
  const isWc = args.includes("--wc");
  const ids = args.filter((a) => !a.startsWith("--") && a !== reason);

  if (ids.length === 0) {
    console.error("no video ids given");
    process.exit(2);
  }

  console.log(`\nQuarantining ${ids.length} job(s) — reason: ${reason}\n`);
  for (const id of ids) {
    const r = await quarantineJob({
      channel: isWc ? "wet-circuit" : "ai-doom-scroll",
      videoId: id,
      table: isWc ? "wc_video" : "Video",
      reason,
      operator: "Max (via Claude Code)",
      actionSource: "scripts/quarantine-stale-jobs.ts",
    });
    console.log(
      `  ${r.videoId}\n    original state : ${r.originalStatus}\n    new state      : ${r.newStatus}\n` +
        `    timestamp      : ${r.createdAt.toISOString()}\n    quarantine id  : ${r.quarantineId}`,
    );
  }

  await list();
  await disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await disconnect();
  process.exit(1);
});
