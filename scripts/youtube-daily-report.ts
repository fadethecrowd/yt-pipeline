/**
 * What happened in the last day.
 *
 *   npx tsx scripts/youtube-daily-report.ts
 *   npx tsx scripts/youtube-daily-report.ts --days 7
 *   npx tsx scripts/youtube-daily-report.ts --json
 *
 * youtube-ops-status answers "what is the system doing now". This answers "what
 * did it do", which is the question that matters for noticing slow drift —
 * a failure rate creeping up, runtimes lengthening, spend per video rising —
 * none of which shows up in a point-in-time status.
 *
 * The window is measured in whole days ending now, not calendar days, so the
 * report means the same thing whenever it is run.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  prisma, disconnect, describeSlot, nextPublishSlot,
  isSchedulerEnabled, isUnattendedMode,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export const CHANNELS = ["ai-doom-scroll", "wet-circuit"] as const;
export type ChannelKey = (typeof CHANNELS)[number];

const VIDEO_TABLE: Record<string, string> = {
  "ai-doom-scroll": "Video",
  "wet-circuit": "wc_video",
};

export interface ChannelReport {
  channel: string;
  runs: { total: number; byStatus: Record<string, number>; live: number; dryRun: number };
  runtime: { avgMin: number | null; maxMin: number | null; longestRunId: string | null };
  cycles: { authorized: number; completed: number; failed: number; reconciliation: number };
  videos: { created: number; scheduled: number; withYoutubeId: number };
  qa: { total: number; passed: number; failed: number };
  spend: { chargedChars: number; requests: number; reservedNow: number };
  slotsInWindow: string[];
  slotsCovered: number;
  /** Uncovered slots. Only a MISS when production was actually armed. */
  uncoveredSlots: string[];
  productionArmed: boolean;
  actionItems: string[];
}

async function reportFor(channel: ChannelKey, since: Date, now: Date): Promise<ChannelReport> {
  const table = VIDEO_TABLE[channel];

  const runs = await prisma.$queryRawUnsafe<
    { id: string; status: string; runMode: string; durationMs: number | null }[]
  >(`SELECT "id", "status"::text AS status, "runMode", "durationMs"
       FROM "pipeline_run" WHERE "channel" = $1 AND "startTime" >= $2`, channel, since);
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const durations = runs.filter((r) => r.durationMs != null);
  const longest = durations.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];

  const cycles = await prisma.$queryRawUnsafe<{ status: string; n: number }[]>(
    `SELECT "status"::text AS status, count(*)::int AS n FROM "production_cycle"
      WHERE "channel" = $1 AND "authorizedAt" >= $2 GROUP BY 1`, channel, since);
  const cy = (s: string): number => cycles.find((c) => c.status === s)?.n ?? 0;

  const [vids] = await prisma.$queryRawUnsafe<
    { created: number; scheduled: number; withYt: number }[]
  >(`SELECT count(*)::int AS created,
            count("scheduledAt")::int AS scheduled,
            count("youtubeId")::int AS "withYt"
       FROM "${table}" WHERE "createdAt" >= $1`, since);

  // QaRecord carries no boolean verdict — it records a result per dimension,
  // each of PASS / FAIL / NOT_REACHED / NOT_UPLOADED. A record passed when no
  // dimension FAILed; NOT_REACHED and NOT_UPLOADED mean the check did not
  // apply, not that it failed. `failureNotes IS NULL` looks like a shortcut but
  // is wrong: rows exist with every dimension PASS and notes still attached.
  const [qa] = await prisma.$queryRawUnsafe<{ total: number; passed: number }[]>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE COALESCE("audioResult",'') <> 'FAIL'
                AND COALESCE("captionResult",'') <> 'FAIL'
                AND COALESCE("visualResult",'') <> 'FAIL'
                AND COALESCE("metadataResult",'') <> 'FAIL'
                AND COALESCE("uploadResult",'') <> 'FAIL'
            )::int AS passed
       FROM "qa_record" WHERE "channel" = $1 AND "createdAt" >= $2`, channel, since);

  const [spend] = await prisma.$queryRawUnsafe<{ chars: number; reqs: number }[]>(
    `SELECT COALESCE(sum("chargedChars"),0)::int AS chars, count(*)::int AS reqs
       FROM "elevenlabs_usage" WHERE "channel" = $1 AND "createdAt" >= $2 AND "success"`,
    channel, since);

  const [res] = await prisma.$queryRawUnsafe<{ reserved: number }[]>(
    `SELECT COALESCE(sum("reservedChars"),0)::int AS reserved
       FROM "credit_budget" WHERE "channel" = $1`, channel);

  // Publication slots that fell inside the window.
  const slots: Date[] = [];
  let cursor = new Date(since.getTime() - 1000);
  for (let i = 0; i < 20; i++) {
    const s = nextPublishSlot(cursor);
    if (s.getTime() > now.getTime()) break;
    slots.push(s);
    cursor = new Date(s.getTime() + 1000);
  }
  const scheduledInstants = new Set((await prisma.$queryRawUnsafe<{ scheduledAt: Date }[]>(
    `SELECT "scheduledAt" FROM "${table}" WHERE "scheduledAt" IS NOT NULL`))
    .map((r) => r.scheduledAt.getTime()));
  const uncovered = slots.filter((s) => !scheduledInstants.has(s.getTime()));

  // A slot that passed while unattended production was switched off is not a
  // miss — it is a system that was deliberately off. Calling it a miss is how a
  // report teaches its reader to ignore it. This mirrors checkMissedSlots.
  const productionArmed = isSchedulerEnabled() && isUnattendedMode();

  const actionItems: string[] = [];
  if (cy("RECONCILIATION_REQUIRED") > 0) {
    actionItems.push(`${cy("RECONCILIATION_REQUIRED")} cycle(s) need human reconciliation — ` +
      "see docs/YOUTUBE_PRODUCTION_OPERATIONS.md §8");
  }
  if ((res?.reserved ?? 0) > 0) {
    actionItems.push(`${res.reserved} narration chars reserved with no run — possible leak`);
  }
  const failedRuns = (byStatus.FAILED ?? 0) + (byStatus.CRITICAL ?? 0);
  if (failedRuns > 0 && failedRuns >= runs.length / 2 && runs.length > 1) {
    actionItems.push(`${failedRuns}/${runs.length} runs failed — investigate before the next slot`);
  }
  if (qa && qa.total > 0 && qa.passed < qa.total) {
    actionItems.push(`${qa.total - qa.passed} QA failure(s) in the window`);
  }
  if (productionArmed && uncovered.length > 0) {
    actionItems.push(`${uncovered.length} publication slot(s) passed with no video`);
  }

  return {
    channel,
    runs: {
      total: runs.length, byStatus,
      live: runs.filter((r) => r.runMode === "LIVE").length,
      dryRun: runs.filter((r) => r.runMode === "DRY_RUN").length,
    },
    runtime: {
      avgMin: durations.length
        ? Number((durations.reduce((a, r) => a + (r.durationMs ?? 0), 0) / durations.length / 60000).toFixed(1))
        : null,
      maxMin: longest ? Number(((longest.durationMs ?? 0) / 60000).toFixed(1)) : null,
      longestRunId: longest?.id ?? null,
    },
    cycles: {
      authorized: cycles.reduce((a, c) => a + c.n, 0),
      completed: cy("COMPLETED"), failed: cy("FAILED"),
      reconciliation: cy("RECONCILIATION_REQUIRED"),
    },
    videos: { created: vids?.created ?? 0, scheduled: vids?.scheduled ?? 0,
      withYoutubeId: vids?.withYt ?? 0 },
    qa: { total: qa?.total ?? 0, passed: qa?.passed ?? 0,
      failed: (qa?.total ?? 0) - (qa?.passed ?? 0) },
    spend: { chargedChars: spend?.chars ?? 0, requests: spend?.reqs ?? 0,
      reservedNow: res?.reserved ?? 0 },
    slotsInWindow: slots.map((s) => s.toISOString()),
    slotsCovered: slots.length - uncovered.length,
    uncoveredSlots: uncovered.map((s) => describeSlot(s)),
    productionArmed,
    actionItems,
  };
}

function print(r: ChannelReport): void {
  console.log(`\n── ${r.channel} ──────────────────────────────────────────`);
  console.log(`  runs        : ${r.runs.total} (${r.runs.live} live, ${r.runs.dryRun} dry-run)` +
    (Object.keys(r.runs.byStatus).length
      ? `  [${Object.entries(r.runs.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}]` : ""));
  console.log(`  runtime     : avg ${r.runtime.avgMin ?? "—"}min  max ${r.runtime.maxMin ?? "—"}min` +
    (r.runtime.longestRunId ? `  (${r.runtime.longestRunId})` : ""));
  console.log(`  cycles      : ${r.cycles.authorized} authorized, ${r.cycles.completed} completed, ` +
    `${r.cycles.failed} failed, ${r.cycles.reconciliation} need reconciliation`);
  console.log(`  videos      : ${r.videos.created} created, ${r.videos.scheduled} scheduled, ` +
    `${r.videos.withYoutubeId} on YouTube`);
  console.log(`  QA          : ${r.qa.passed}/${r.qa.total} passed`);
  console.log(`  spend       : ${r.spend.chargedChars} chars over ${r.spend.requests} request(s)` +
    (r.spend.reservedNow ? `  ⚠ ${r.spend.reservedNow} still reserved` : ""));
  console.log(`  slots       : ${r.slotsCovered}/${r.slotsInWindow.length} covered` +
    (r.productionArmed ? "" : "  (unattended production not armed — uncovered is expected)"));
  for (const m of r.uncoveredSlots) {
    console.log(`      ${r.productionArmed ? "MISSED" : "uncovered"}: ${m}`);
  }
  if (r.actionItems.length) {
    console.log(`  ACTION ITEMS:`);
    for (const a of r.actionItems) console.log(`    • ${a}`);
  }
}

export async function main(): Promise<void> {
  const KNOWN = ["--days", "--json", "--channel"];
  const unknown = process.argv.slice(2).filter(
    (a) => a.startsWith("--") && !KNOWN.includes(a));
  if (unknown.length) {
    console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
    console.error(`  usage: --days <n> --channel <${CHANNELS.join("|")}> --json`);
    process.exitCode = 2; return;
  }

  const di = process.argv.indexOf("--days");
  const days = di >= 0 ? Number(process.argv[di + 1]) : 1;
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    console.error("✗ --days must be a number between 1 and 365");
    process.exitCode = 2; return;
  }
  const ci = process.argv.indexOf("--channel");
  const arg = ci >= 0 ? process.argv[ci + 1] as ChannelKey : undefined;
  if (arg && !CHANNELS.includes(arg)) {
    console.error(`✗ --channel must be one of ${CHANNELS.join(" | ")}`);
    process.exitCode = 2; return;
  }

  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const channels = arg ? [arg] : [...CHANNELS];
  const reports: ChannelReport[] = [];
  for (const c of channels) reports.push(await reportFor(c, since, now));

  const totalSpend = reports.reduce((a, r) => a + r.spend.chargedChars, 0);
  const totalVideos = reports.reduce((a, r) => a + r.videos.created, 0);
  const allActions = reports.flatMap((r) => r.actionItems);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      windowStart: since.toISOString(), windowEnd: now.toISOString(), days,
      channels: reports, totals: { spendChars: totalSpend, videos: totalVideos },
      actionItems: allActions,
    }, null, 2));
    return;
  }

  console.log(`\n══ DAILY REPORT — ${days} day(s) to ${now.toISOString()} ══`);
  for (const r of reports) print(r);
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  total narration spend : ${totalSpend} chars`);
  console.log(`  total videos created  : ${totalVideos}`);
  console.log(`  action items          : ${allActions.length}`);
  for (const a of allActions) console.log(`    • ${a}`);
  console.log("");
}

const isDirectRun =
  process.argv[1]?.endsWith("youtube-daily-report.ts") ||
  process.argv[1]?.endsWith("youtube-daily-report.js");

if (isDirectRun) {
  main().catch((e) => { console.error("REPORT FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
