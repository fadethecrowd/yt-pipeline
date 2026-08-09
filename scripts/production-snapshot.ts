/**
 * Read-only snapshot of every production table that a pass could disturb.
 *
 *   npx tsx scripts/production-snapshot.ts
 *   npx tsx scripts/production-snapshot.ts --json > before.json
 *
 * The point is comparison, not browsing. Taking one before any work and one
 * after is how "nothing was produced today" stops being a claim and becomes
 * evidence: identical counts and identical newest-row timestamps across every
 * table that a candidate, a narration charge, a render or an upload would have
 * touched.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT. Nothing here writes, and
 * nothing here can be made to write by passing a flag.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import { prisma, disconnect } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export interface TableStat {
  table: string;
  rows: number;
  newest: string | null;
}

export interface Snapshot {
  takenAt: string;
  tables: TableStat[];
  productionCycles: Record<string, number>;
  budgets: { channel: string; stage: string; limit: number; reserved: number; charged: number }[];
  pilots: { pilotId: string; status: string; successCount: number; maxSuccesses: number;
            successVideoIds: string[] }[];
  activeRuns: { id: string; channel: string; status: string; startTime: string }[];
  unresolvedIntents: { id: string; state: string; videoId: string | null }[];
  futureScheduled: { table: string; id: string; scheduledAt: string; youtubeId: string | null }[];
  breakers: { channel: string; tripped: boolean }[];
}

/** Tables whose row count must not move during a no-production pass. */
const WATCHED: { table: string; tsColumn: string }[] = [
  { table: "Topic", tsColumn: "createdAt" },
  { table: "Video", tsColumn: "createdAt" },
  { table: "wc_topic", tsColumn: "createdAt" },
  { table: "wc_video", tsColumn: "createdAt" },
  { table: "production_cycle", tsColumn: "authorizedAt" },
  { table: "pipeline_run", tsColumn: "startTime" },
  { table: "elevenlabs_usage", tsColumn: "createdAt" },
  { table: "qa_record", tsColumn: "createdAt" },
  { table: "scene_record", tsColumn: "createdAt" },
  { table: "upload_intent", tsColumn: "createdAt" },
  { table: "production_pilot", tsColumn: "createdAt" },
  { table: "topic_library", tsColumn: "createdAt" },
  { table: "job_quarantine", tsColumn: "createdAt" },
];

export async function takeSnapshot(): Promise<Snapshot> {
  const tables: TableStat[] = [];
  for (const { table, tsColumn } of WATCHED) {
    const [row] = await prisma.$queryRawUnsafe<{ n: number; newest: Date | null }[]>(
      `SELECT count(*)::int AS n, max("${tsColumn}") AS newest FROM "${table}"`,
    );
    tables.push({ table, rows: row.n, newest: row.newest ? row.newest.toISOString() : null });
  }

  const cycleRows = await prisma.$queryRawUnsafe<{ status: string; n: number }[]>(
    `SELECT "status", count(*)::int AS n FROM "production_cycle" GROUP BY "status"`,
  );
  const productionCycles: Record<string, number> = {};
  for (const r of cycleRows) productionCycles[r.status] = r.n;

  const budgets = await prisma.$queryRawUnsafe<
    { channel: string; stage: string; limit: number; reserved: number; charged: number }[]
  >(`SELECT "channel", "testStage"::text AS stage, "limitChars" AS limit,
            "reservedChars" AS reserved, "chargedChars" AS charged
       FROM "credit_budget" ORDER BY "channel", "testStage"`);

  const pilots = await prisma.$queryRawUnsafe<
    { pilotId: string; status: string; successCount: number; maxSuccesses: number;
      successVideoIds: string[] }[]
  >(`SELECT "pilotId", "status"::text AS status, "successCount", "maxSuccesses", "successVideoIds"
       FROM "production_pilot" ORDER BY "pilotId"`);

  // There is no RUNNING status — a run row is written when it ENDS. An
  // in-flight (or abandoned) run is therefore one with no endTime, which is
  // also exactly what a killed container leaves behind.
  const activeRunsRaw = await prisma.$queryRawUnsafe<
    { id: string; channel: string; status: string; startTime: Date }[]
  >(`SELECT "id", "channel", "status"::text AS status, "startTime"
       FROM "pipeline_run" WHERE "endTime" IS NULL ORDER BY "startTime" DESC`);
  const activeRuns = activeRunsRaw.map((r) => ({ ...r, startTime: r.startTime.toISOString() }));

  // Unresolved = anything that is not a terminal, upload-blocking outcome.
  // UPLOAD_STARTED and REMOTE_CONFIRMED matter most: both mean YouTube may
  // hold an object we have not recorded.
  const unresolvedIntents = await prisma.$queryRawUnsafe<
    { id: string; state: string; videoId: string | null }[]
  >(`SELECT "id", "state"::text AS state, "videoId" FROM "upload_intent"
      WHERE "state" NOT IN ('PERSISTED', 'RECONCILED_HISTORICAL_UPLOAD',
                            'FAILED_BEFORE_REMOTE_CALL')
      ORDER BY "createdAt" DESC`);

  const futureScheduled: Snapshot["futureScheduled"] = [];
  for (const t of ["Video", "wc_video"]) {
    const rows = await prisma.$queryRawUnsafe<
      { id: string; scheduledAt: Date; youtubeId: string | null }[]
    >(`SELECT "id", "scheduledAt", "youtubeId" FROM "${t}"
        WHERE "scheduledAt" IS NOT NULL AND "scheduledAt" > NOW() ORDER BY "scheduledAt"`);
    for (const r of rows) {
      futureScheduled.push({ table: t, id: r.id,
        scheduledAt: r.scheduledAt.toISOString(), youtubeId: r.youtubeId });
    }
  }

  const breakers = await prisma.$queryRawUnsafe<{ channel: string; tripped: boolean }[]>(
    `SELECT "channel", "tripped" FROM "circuit_breaker" ORDER BY "channel"`,
  );

  return {
    takenAt: new Date().toISOString(),
    tables, productionCycles, budgets, pilots, activeRuns,
    unresolvedIntents, futureScheduled, breakers,
  };
}

/** Field-by-field comparison. Empty result means nothing moved. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const b of before.tables) {
    const a = after.tables.find((x) => x.table === b.table);
    if (!a) { out.push(`${b.table}: missing from after-snapshot`); continue; }
    if (a.rows !== b.rows) out.push(`${b.table}: rows ${b.rows} → ${a.rows}`);
    if (a.newest !== b.newest) out.push(`${b.table}: newest ${b.newest} → ${a.newest}`);
  }
  for (const b of before.budgets) {
    const a = after.budgets.find((x) => x.channel === b.channel && x.stage === b.stage);
    if (!a) { out.push(`budget ${b.channel}/${b.stage}: missing`); continue; }
    if (a.charged !== b.charged) out.push(`budget ${b.channel}/${b.stage}: charged ${b.charged} → ${a.charged}`);
    if (a.reserved !== b.reserved) out.push(`budget ${b.channel}/${b.stage}: reserved ${b.reserved} → ${a.reserved}`);
    if (a.limit !== b.limit) out.push(`budget ${b.channel}/${b.stage}: limit ${b.limit} → ${a.limit}`);
  }
  for (const b of before.pilots) {
    const a = after.pilots.find((x) => x.pilotId === b.pilotId);
    if (!a) { out.push(`pilot ${b.pilotId}: missing`); continue; }
    if (a.status !== b.status) out.push(`pilot ${b.pilotId}: status ${b.status} → ${a.status}`);
    if (a.successCount !== b.successCount) {
      out.push(`pilot ${b.pilotId}: successCount ${b.successCount} → ${a.successCount}`);
    }
    if (a.successVideoIds.join() !== b.successVideoIds.join()) {
      out.push(`pilot ${b.pilotId}: successVideoIds changed`);
    }
  }
  if (before.futureScheduled.length !== after.futureScheduled.length) {
    out.push(`futureScheduled: ${before.futureScheduled.length} → ${after.futureScheduled.length}`);
  }
  if (before.unresolvedIntents.length !== after.unresolvedIntents.length) {
    out.push(`unresolvedIntents: ${before.unresolvedIntents.length} → ${after.unresolvedIntents.length}`);
  }
  return out;
}

function print(s: Snapshot): void {
  console.log(`\n═══ PRODUCTION SNAPSHOT ${s.takenAt} ═══\n`);
  console.log("  TABLE                 ROWS   NEWEST");
  for (const t of s.tables) {
    console.log(`  ${t.table.padEnd(20)} ${String(t.rows).padStart(5)}   ${t.newest ?? "—"}`);
  }
  console.log(`\n  production_cycle by status: ` +
    `${Object.keys(s.productionCycles).length ? JSON.stringify(s.productionCycles) : "none — 0 rows"}`);
  console.log("\n  CREDIT BUDGETS");
  for (const b of s.budgets) {
    console.log(`    ${b.channel}/${b.stage}: limit ${b.limit}  reserved ${b.reserved}  charged ${b.charged}`);
  }
  console.log("\n  PILOTS");
  for (const p of s.pilots) {
    console.log(`    ${p.pilotId}: ${p.status} ${p.successCount}/${p.maxSuccesses} ` +
      `videos=[${p.successVideoIds.join(", ")}]`);
  }
  console.log(`\n  active runs         : ${s.activeRuns.length}`);
  for (const r of s.activeRuns) console.log(`    ${r.id} ${r.channel} since ${r.startTime}`);
  console.log(`  unresolved intents  : ${s.unresolvedIntents.length}`);
  for (const i of s.unresolvedIntents) console.log(`    ${i.id} ${i.state} video=${i.videoId ?? "—"}`);
  console.log(`  future scheduled    : ${s.futureScheduled.length}`);
  for (const f of s.futureScheduled) {
    console.log(`    ${f.table} ${f.id} @ ${f.scheduledAt} yt=${f.youtubeId ?? "—"}`);
  }
  const tripped = s.breakers.filter((b) => b.tripped);
  console.log(`  circuit breakers    : ${tripped.length ? `TRIPPED ${tripped.map((b) => b.channel).join(", ")}` : "all clear"}`);
}

export async function main(): Promise<void> {
  const snap = await takeSnapshot();
  if (process.argv.includes("--json")) console.log(JSON.stringify(snap, null, 2));
  else print(snap);
}

const isDirectRun =
  process.argv[1]?.endsWith("production-snapshot.ts") ||
  process.argv[1]?.endsWith("production-snapshot.js");

if (isDirectRun) {
  main().catch((e) => { console.error("SNAPSHOT FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
