/**
 * The everyday "what is the system doing?" command.
 *
 *   npx tsx scripts/youtube-ops-status.ts
 *   npx tsx scripts/youtube-ops-status.ts --channel wet-circuit
 *   npx tsx scripts/youtube-ops-status.ts --json
 *
 * monday-preflight answers a narrower question — "is it safe to start today's
 * pilot?" — and is organised as a pass/fail gate. This answers the ongoing one:
 * what is each channel's state right now, what is it about to do, and is
 * anything wrong. It is the command to run on an ordinary day once unattended
 * production is live.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT, the scheduler is consulted in
 * dry-run mode, and nothing here can be made to mutate by passing a flag.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  prisma, disconnect,
  isSchedulerEnabled, isUnattendedMode, schedulerTick, realSchedulerDeps,
  nextCycleSlot, describeSlot, publicationPolicyFor,
  evaluateCycleHealth, ownerAppearsGone, channelLockId,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS, CLAIM_STALE_AFTER_MS,
  nextPublishSlot,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, CycleFinding } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export const CHANNELS = ["ai-doom-scroll", "wet-circuit"] as const;
export type ChannelKey = (typeof CHANNELS)[number];

const VIDEO_TABLE: Record<string, string> = {
  "ai-doom-scroll": "Video",
  "wet-circuit": "wc_video",
};

/** How many past slots to examine for misses. One week of Mon/Wed/Fri. */
const LOOKBACK_SLOTS = 3;

export interface ChannelStatus {
  channel: string;
  schedulerEnabled: boolean;
  unattendedEnabled: boolean;
  policy: { days: number[]; hour: number; timeZone: string };
  nextSlot: string;
  leadHours: number;
  inLeadWindow: boolean;
  schedulerWouldDo: string;
  openCycle: ProductionCycle | null;
  cycleAgeMinutes: number | null;
  lockHeld: boolean;
  recentCycles: { id: string; slot: string; status: string; videoId: string | null }[];
  activeRuns: { id: string; startTime: string; ageMinutes: number }[];
  lastCompletedRun: { id: string; status: string; endTime: string | null; youtubeId: string | null } | null;
  budgets: { stage: string; limit: number; reserved: number; charged: number }[];
  unresolvedIntents: { id: string; state: string; videoId: string | null }[];
  futureScheduled: { id: string; scheduledAt: string; youtubeId: string | null }[];
  pilot: { pilotId: string; status: string; successCount: number; maxSuccesses: number } | null;
  findings: CycleFinding[];
  status: "HEALTHY" | "ATTENTION_REQUIRED";
  reasons: string[];
}

/** The last `count` publication slots at or before `now`. */
function recentSlots(now: Date, count: number): Date[] {
  const out: Date[] = [];
  // Walk backwards a day at a time and keep slots that have passed.
  let cursor = new Date(now.getTime() - 14 * 86_400_000);
  while (out.length < 50) {
    const s = nextPublishSlot(cursor);
    if (s.getTime() > now.getTime()) break;
    out.push(s);
    cursor = new Date(s.getTime() + 1000);
  }
  return out.slice(-count);
}

export async function statusFor(channel: ChannelKey, now = new Date()): Promise<ChannelStatus> {
  const schedulerEnabled = isSchedulerEnabled();
  const unattendedEnabled = isUnattendedMode();
  const p = publicationPolicyFor(channel);
  const slot = await nextCycleSlot(channel, now);
  const leadMs = slot.getTime() - now.getTime();

  const dry = await schedulerTick(channel, realSchedulerDeps(), { now, dryRun: true });

  const cycles = await prisma.$queryRawUnsafe<ProductionCycle[]>(
    `SELECT * FROM "production_cycle" WHERE "channel" = $1
      ORDER BY "targetPublishSlot" DESC LIMIT 10`, channel);
  const openCycle = cycles.find((c) =>
    (c.status === "AUTHORIZED" || c.status === "CLAIMED") &&
    new Date(c.targetPublishSlot).getTime() > now.getTime()) ?? null;

  const lockFree = await ownerAppearsGone(channel);

  const table = VIDEO_TABLE[channel];
  const runsRaw = await prisma.$queryRawUnsafe<
    { id: string; startTime: Date; endTime: Date | null; status: string; youtubeId: string | null }[]
  >(`SELECT "id", "startTime", "endTime", "status"::text AS status, "youtubeId"
       FROM "pipeline_run" WHERE "channel" = $1 ORDER BY "startTime" DESC LIMIT 10`, channel);
  const activeRuns = runsRaw.filter((r) => !r.endTime).map((r) => ({
    id: r.id, startTime: r.startTime.toISOString(),
    ageMinutes: Math.round((now.getTime() - r.startTime.getTime()) / 60000),
  }));
  const lastDone = runsRaw.find((r) => r.endTime);

  const budgets = await prisma.$queryRawUnsafe<
    { stage: string; limit: number; reserved: number; charged: number }[]
  >(`SELECT "testStage"::text AS stage, "limitChars" AS limit,
            "reservedChars" AS reserved, "chargedChars" AS charged
       FROM "credit_budget" WHERE "channel" = $1 ORDER BY "testStage"`, channel);

  const unresolvedIntents = await prisma.$queryRawUnsafe<
    { id: string; state: string; videoId: string | null }[]
  >(`SELECT i."id", i."state"::text AS state, i."videoId" FROM "upload_intent" i
      WHERE i."channel" = $1
        AND i."state" NOT IN ('PERSISTED','RECONCILED_HISTORICAL_UPLOAD','FAILED_BEFORE_REMOTE_CALL')
      ORDER BY i."createdAt" DESC`, channel);

  const futureRaw = await prisma.$queryRawUnsafe<
    { id: string; scheduledAt: Date; youtubeId: string | null }[]
  >(`SELECT "id", "scheduledAt", "youtubeId" FROM "${table}"
      WHERE "scheduledAt" IS NOT NULL AND "scheduledAt" > NOW() ORDER BY "scheduledAt"`);

  const pilots = await prisma.$queryRawUnsafe<
    { pilotId: string; status: string; successCount: number; maxSuccesses: number }[]
  >(`SELECT "pilotId", "status"::text AS status, "successCount", "maxSuccesses"
       FROM "production_pilot" WHERE "channel" = $1 LIMIT 1`, channel);

  const slots = recentSlots(now, LOOKBACK_SLOTS);
  const scheduledInstants = (await prisma.$queryRawUnsafe<{ scheduledAt: Date }[]>(
    `SELECT "scheduledAt" FROM "${table}" WHERE "scheduledAt" IS NOT NULL`))
    .map((r) => r.scheduledAt.getTime());

  const health = evaluateCycleHealth({
    channel,
    cycles: cycles.map((c) => ({ ...c, targetPublishSlot: new Date(c.targetPublishSlot) })),
    recentSlots: slots,
    scheduledSlotInstants: scheduledInstants,
    schedulerEnabled, unattendedEnabled, now,
  });

  const reasons: string[] = [];
  for (const f of health.findings) reasons.push(`${f.severity} ${f.code}: ${f.detail}`);
  if (unresolvedIntents.length) {
    reasons.push(`ALERT UNRESOLVED_UPLOAD_INTENT: ${unresolvedIntents.length} intent(s) unresolved`);
  }
  for (const b of budgets) {
    if (b.reserved !== 0) {
      reasons.push(`ALERT STALE_RESERVATION: ${b.stage} holds ${b.reserved} reserved chars`);
    }
  }
  const alerting = reasons.some((r) => r.startsWith("ALERT"));

  return {
    channel, schedulerEnabled, unattendedEnabled,
    policy: { days: p.days, hour: p.hour, timeZone: p.timeZone },
    nextSlot: describeSlot(slot),
    leadHours: Number((leadMs / 3600000).toFixed(1)),
    inLeadWindow: leadMs <= AUTHORIZATION_LEAD_MS && leadMs >= MINIMUM_LEAD_MS,
    schedulerWouldDo: `${dry.outcome} — ${dry.reason}`,
    openCycle,
    cycleAgeMinutes: openCycle?.claimedAt
      ? Math.round((now.getTime() - new Date(openCycle.claimedAt).getTime()) / 60000) : null,
    lockHeld: !lockFree,
    recentCycles: cycles.map((c) => ({
      id: c.id, slot: new Date(c.targetPublishSlot).toISOString(),
      status: c.status, videoId: c.videoId })),
    activeRuns,
    lastCompletedRun: lastDone ? {
      id: lastDone.id, status: lastDone.status,
      endTime: lastDone.endTime?.toISOString() ?? null, youtubeId: lastDone.youtubeId } : null,
    budgets,
    unresolvedIntents,
    futureScheduled: futureRaw.map((f) => ({
      id: f.id, scheduledAt: f.scheduledAt.toISOString(), youtubeId: f.youtubeId })),
    pilot: pilots[0] ?? null,
    findings: health.findings,
    status: alerting ? "ATTENTION_REQUIRED" : "HEALTHY",
    reasons,
  };
}

function print(s: ChannelStatus): void {
  console.log(`\n══ ${s.channel} ═══════════════════════════════════════════════`);
  console.log(`  scheduler       : ${s.schedulerEnabled ? "ENABLED" : "disabled"}`);
  console.log(`  unattended mode : ${s.unattendedEnabled ? "ENABLED" : "disabled"}`);
  console.log(`  policy          : days ${JSON.stringify(s.policy.days)} at ` +
    `${s.policy.hour}:00 ${s.policy.timeZone}`);
  console.log(`  next slot       : ${s.nextSlot}`);
  console.log(`  lead            : ${s.leadHours}h  in-window: ${s.inLeadWindow ? "yes" : "no"}`);
  console.log(`  scheduler would : ${s.schedulerWouldDo}`);
  console.log(`  advisory lock   : ${s.lockHeld ? "HELD (a pipeline is running)" : "free"}`);

  if (s.openCycle) {
    const c = s.openCycle;
    console.log(`  open cycle      : ${c.id} ${c.status}`);
    console.log(`      slot ${new Date(c.targetPublishSlot).toISOString()}  video ${c.videoId ?? "—"}`);
    console.log(`      claimant ${c.claimantId ?? "—"}` +
      (s.cycleAgeMinutes !== null
        ? `  claimed ${s.cycleAgeMinutes}min ago (stale at ${CLAIM_STALE_AFTER_MS / 60000}min)` : ""));
  } else {
    console.log(`  open cycle      : none — a container start would do nothing`);
  }

  console.log(`  active runs     : ${s.activeRuns.length}` +
    s.activeRuns.map((r) => `\n      ${r.id} ${r.ageMinutes}min`).join(""));
  console.log(`  last run        : ${s.lastCompletedRun
    ? `${s.lastCompletedRun.status} at ${s.lastCompletedRun.endTime} yt=${s.lastCompletedRun.youtubeId ?? "—"}`
    : "none"}`);
  const spend = s.budgets.filter((b) => b.charged || b.reserved || b.limit);
  console.log(`  budgets         : ${spend.map((b) =>
    `${b.stage} ${b.charged}/${b.limit}${b.reserved ? ` (+${b.reserved} reserved)` : ""}`).join("  ") || "all zero"}`);
  console.log(`  unresolved intents: ${s.unresolvedIntents.length}`);
  console.log(`  future scheduled: ${s.futureScheduled.length}` +
    s.futureScheduled.map((f) => `\n      ${f.id} @ ${f.scheduledAt} yt=${f.youtubeId ?? "—"}`).join(""));
  console.log(`  pilot           : ${s.pilot
    ? `${s.pilot.pilotId} ${s.pilot.status} ${s.pilot.successCount}/${s.pilot.maxSuccesses}` : "none"}`);
  console.log(`  recent cycles   : ${s.recentCycles.length
    ? s.recentCycles.map((c) => `${c.status}@${c.slot.slice(0, 10)}`).join("  ") : "none"}`);

  if (s.reasons.length) {
    console.log(`\n  FINDINGS:`);
    for (const r of s.reasons) console.log(`    ${r}`);
  }
  console.log(`\n  CHANNEL_STATUS = ${s.status}`);
}

export async function main(): Promise<void> {
  const MODES = ["--json", "--channel"];
  const unknown = process.argv.slice(2).filter(
    (a) => a.startsWith("--") && !MODES.includes(a));
  if (unknown.length) {
    console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
    console.error(`  usage: --channel <${CHANNELS.join("|")}> --json`);
    process.exitCode = 2; return;
  }

  const i = process.argv.indexOf("--channel");
  const arg = i >= 0 ? process.argv[i + 1] as ChannelKey : undefined;
  if (arg && !CHANNELS.includes(arg)) {
    console.error(`✗ --channel must be one of ${CHANNELS.join(" | ")}`);
    process.exitCode = 2; return;
  }
  const channels = arg ? [arg] : [...CHANNELS];

  const all: ChannelStatus[] = [];
  for (const c of channels) all.push(await statusFor(c));

  const overall = all.every((s) => s.status === "HEALTHY") ? "HEALTHY" : "ATTENTION_REQUIRED";

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ takenAt: new Date().toISOString(),
      channels: all, systemStatus: overall }, null, 2));
    if (overall !== "HEALTHY") process.exitCode = 1;
    return;
  }

  for (const s of all) print(s);
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  YOUTUBE_SYSTEM_STATUS = ${overall}\n`);
  if (overall !== "HEALTHY") process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("youtube-ops-status.ts") ||
  process.argv[1]?.endsWith("youtube-ops-status.js");

if (isDirectRun) {
  main().catch((e) => { console.error("STATUS FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
