/**
 * Post-review publication control for both channels.
 *
 *   npx tsx scripts/video-publication-control.ts --channel ai-doom-scroll --video <rowId>
 *   npx tsx scripts/video-publication-control.ts --channel wet-circuit  --video <rowId> \
 *       --publish-at "2026-08-12 15:00"
 *   ... --schedule --i-have-reviewed-and-approved-this-video
 *   ... --verify
 *
 * The controlled transition this encodes is:
 *
 *   PRIVATE + UNSCHEDULED  →  HUMAN APPROVED  →  SCHEDULED FOR A FUTURE GO-LIVE
 *
 * CHECK (the default) and VERIFY are read-only. SCHEDULE is the only mode that
 * may write to YouTube, and it needs an explicit acknowledgement flag AND an
 * exact durable row id. There is deliberately no "schedule the newest video":
 * approval is about one specific reviewed asset, so the asset must be named.
 *
 * LOCAL ONLY. Neither runtime imports this module.
 */
import { createHash } from "node:crypto";
import { existsSync, createReadStream } from "node:fs";
import { prisma, disconnect, zonedParts } from "@yt-pipeline/pipeline-core";
import {
  authoritativeQaRecord, decideQaAuthorization, ARTIFACT_CHECK,
} from "../src/stages/finalVideoQa";
import "dotenv/config";

// ── Channel policy ────────────────────────────────────────────────────────

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";

export interface ChannelPolicy {
  key: ChannelKey;
  /** Prisma model holding long-form rows for this channel. */
  model: "video" | "wcVideo";
  pilotId: string;
  timezone: string;
  /** Publication weekdays, 1=Mon. Matches the pilot cadence; unchanged here. */
  days: number[];
  /**
   * Operator-selectable hour range, derived from durable history rather than
   * invented: every scheduled row on both channels landed on Mon/Wed/Fri, at
   * 15:00 ET (dominant, and the only value WC ever used) or 10:00 ET (four
   * older AI Doom rows). The lower bound is the earliest observed hour; the
   * upper bound is the pilot execution window's own end hour, which is already
   * policy. No exact hour is imposed, because the evidence does not define one.
   */
  minHour: number;
  maxHour: number;
  /** The dominant historical hour, reported as guidance only. */
  historicalHour: number;
}

export const POLICIES: Record<ChannelKey, ChannelPolicy> = {
  "ai-doom-scroll": {
    key: "ai-doom-scroll", model: "video", pilotId: "ai-doom-private-pilot-1",
    timezone: "America/New_York", days: [1, 3, 5],
    minHour: 10, maxHour: 20, historicalHour: 15,
  },
  "wet-circuit": {
    key: "wet-circuit", model: "wcVideo", pilotId: "wet-circuit-private-canary-1",
    timezone: "America/New_York", days: [1, 3, 5],
    minHour: 10, maxHour: 20, historicalHour: 15,
  },
};

// ── Injected surface ──────────────────────────────────────────────────────

export interface YouTubeStatus {
  privacyStatus: string | null;
  publishAt: string | null;
  /** Everything else in the status part, preserved verbatim on update. */
  rest: Record<string, unknown>;
}

export interface VideoRow {
  id: string;
  youtubeId: string | null;
  status: string;
  scheduledAt: Date | null;
  videoPath: string | null;
}

export interface QaRow { id: string; overall: string; checks: unknown; createdAt: Date }

export interface PubDeps {
  readRow(model: string, id: string): Promise<VideoRow | null>;
  readPilot(pilotId: string): Promise<{ successVideoIds: string[]; channel: string } | null>;
  readQa(channel: string, videoId: string): Promise<QaRow[]>;
  unresolvedIntentCount(): Promise<number>;
  /** Future scheduled long-form rows for the channel, for collision checks. */
  futureScheduled(model: string, after: Date): Promise<{ id: string; scheduledAt: Date }[]>;
  ytGetStatus(youtubeId: string): Promise<YouTubeStatus | null>;
  /** The ONLY write. Sends part=["status"] with a complete merged status. */
  ytSetStatus(youtubeId: string, status: Record<string, unknown>): Promise<void>;
  setScheduledAt(model: string, id: string, at: Date): Promise<number>;
  fileSha256(path: string): Promise<string | null>;
  now(): Date;
  log(line: string): void;
}

// ── Time handling ─────────────────────────────────────────────────────────

/**
 * Parse "YYYY-MM-DD HH:mm" as a wall-clock time in `tz`, DST-safe.
 *
 * Never uses the host timezone: it guesses a UTC instant, asks what that reads
 * as locally, and corrects by the observed offset. Two passes settle any DST
 * boundary.
 */
export function parseZoned(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number) as unknown as number[];
  let guess = Date.UTC(Y!, Mo! - 1, D!, H!, Mi!, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const target = Date.UTC(Y!, Mo! - 1, D!, H!, Mi!, 0, 0);
    if (asLocal === target) return new Date(guess);
    guess += target - asLocal;
  }
  return new Date(guess);
}

export function formatZonedFull(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).format(d);
}

export interface SlotDecision { ok: boolean; code: string; detail: string }

export function validateSlot(
  when: Date, now: Date, policy: ChannelPolicy, occupied: Date[],
): SlotDecision {
  if (!Number.isFinite(when.getTime())) return { ok: false, code: "SLOT_UNPARSEABLE", detail: "not a date" };
  if (when.getTime() <= now.getTime()) {
    return { ok: false, code: "SLOT_NOT_FUTURE",
      detail: `${formatZonedFull(when, policy.timezone)} is not after now` };
  }
  const p = zonedParts(when, policy.timezone);
  if (!policy.days.includes(p.weekday)) {
    return { ok: false, code: "SLOT_WRONG_DAY",
      detail: `weekday ${p.weekday} is not in ${JSON.stringify(policy.days)} (1=Mon)` };
  }
  if (p.hour < policy.minHour || p.hour >= policy.maxHour) {
    return { ok: false, code: "SLOT_OUTSIDE_HOURS",
      detail: `${p.hour}:00 local is outside ${policy.minHour}:00-${policy.maxHour}:00 (end exclusive)` };
  }
  const clash = occupied.find((o) => o.getTime() === when.getTime());
  if (clash) {
    return { ok: false, code: "SLOT_OCCUPIED",
      detail: `${formatZonedFull(clash, policy.timezone)} already has a scheduled video` };
  }
  return { ok: true, code: "SLOT_OK",
    detail: `${formatZonedFull(when, policy.timezone)} → ${when.toISOString()}` };
}

/** Next `count` unoccupied publication dates, for calendar inventory. */
export function upcomingSlots(
  from: Date, policy: ChannelPolicy, occupied: Date[], count: number,
): { date: string; local: string }[] {
  const out: { date: string; local: string }[] = [];
  const taken = new Set(occupied.map((o) => {
    const p = zonedParts(o, policy.timezone);
    return `${p.year}-${p.month}-${p.day}`;
  }));
  const cursor = new Date(from.getTime());
  for (let i = 0; i < 60 && out.length < count; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const p = zonedParts(cursor, policy.timezone);
    if (!policy.days.includes(p.weekday)) continue;
    const key = `${p.year}-${p.month}-${p.day}`;
    if (taken.has(key)) continue;
    const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    out.push({
      date: iso,
      local: `${iso} — operator-selectable ${policy.minHour}:00-${policy.maxHour}:00 ` +
             `${policy.timezone} (historical norm ${policy.historicalHour}:00)`,
    });
  }
  return out;
}

// ── Eligibility ───────────────────────────────────────────────────────────

export type Phase =
  | "PRIVATE_AWAITING_REVIEW"
  | "ELIGIBLE_FOR_SCHEDULING"
  | "ALREADY_SCHEDULED"
  | "ALREADY_PUBLIC"
  | "RECONCILIATION_REQUIRED"
  | "QA_INVALID"
  | "PROVENANCE_INVALID"
  | "CONFIG_INVALID";

export interface Eligibility {
  phase: Phase;
  checks: { ok: boolean; label: string; detail: string }[];
  row: VideoRow | null;
  yt: YouTubeStatus | null;
  qaId: string | null;
}

export async function evaluateEligibility(
  deps: PubDeps, policy: ChannelPolicy, rowId: string,
): Promise<Eligibility> {
  const checks: Eligibility["checks"] = [];
  const add = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });
  let qaId: string | null = null;

  const row = await deps.readRow(policy.model, rowId);
  add(!!row, "durable row exists", row ? row.id : "MISSING");
  if (!row) return { phase: "PROVENANCE_INVALID", checks, row: null, yt: null, qaId };

  // Provenance: the asset must be a recorded pilot success for THIS channel's
  // pilot. This is what makes an arbitrary YouTube id unschedulable.
  const pilot = await deps.readPilot(policy.pilotId);
  add(!!pilot, "pilot record exists", pilot ? policy.pilotId : "MISSING");
  const provenance = !!pilot && pilot.channel === policy.key && pilot.successVideoIds.includes(row.id);
  add(provenance, "video is a recorded pilot success",
    pilot ? `successVideoIds=${JSON.stringify(pilot.successVideoIds)}` : "no pilot");

  add(!!row.youtubeId, "youtubeId present", row.youtubeId ?? "null");
  add(row.status === "UPLOADED", "durable status UPLOADED", row.status);
  add(row.scheduledAt === null, "not already scheduled durably",
    row.scheduledAt ? row.scheduledAt.toISOString() : "null");

  const unresolved = await deps.unresolvedIntentCount();
  add(unresolved === 0, "no unresolved upload intent", String(unresolved));

  // Final QA must PASS and be bound to the artifact.
  const qa = await deps.readQa(policy.key, row.id);
  const authoritative = authoritativeQaRecord(qa);
  let sha: string | null = null;
  if (row.videoPath) sha = await deps.fileSha256(row.videoPath);
  if (!authoritative) {
    add(false, "final QA record present", "none");
  } else if (sha) {
    const d = decideQaAuthorization(authoritative, sha);
    add(d.ok, "final QA PASS bound to current artifact", d.ok ? authoritative.id : `${d.code}: ${d.message}`);
    if (d.ok) qaId = d.qaId;
  } else {
    // The local render may be gone long after upload. The binding must still
    // exist and the verdict must still be PASS; only the byte comparison is
    // unavailable, and that is reported rather than silently skipped.
    const bound = Array.isArray(authoritative.checks)
      ? (authoritative.checks as { name?: string; value?: unknown }[])
          .find((c) => c?.name === ARTIFACT_CHECK)
      : undefined;
    const ok = authoritative.overall === "PASS" &&
      typeof bound?.value === "string" && /^[0-9a-f]{64}$/.test(bound.value);
    add(ok, "final QA PASS with artifact binding (local file absent)",
      ok ? `${authoritative.id} bound to ${String(bound!.value).slice(0, 16)}…`
         : `overall=${authoritative.overall}`);
    if (ok) qaId = authoritative.id;
  }

  const yt = row.youtubeId ? await deps.ytGetStatus(row.youtubeId) : null;
  add(!!yt, "YouTube status readable", yt ? `privacy=${yt.privacyStatus}` : "unreadable");
  if (yt) {
    add(yt.privacyStatus === "private", "currently PRIVATE on YouTube", yt.privacyStatus ?? "null");
    add(!yt.publishAt, "no publishAt on YouTube", yt.publishAt ?? "none");
  }

  // ── Phase ─────────────────────────────────────────────────────────
  let phase: Phase;
  if (unresolved > 0) phase = "RECONCILIATION_REQUIRED";
  else if (!provenance) phase = "PROVENANCE_INVALID";
  else if (!row.youtubeId || row.status !== "UPLOADED") phase = "CONFIG_INVALID";
  else if (yt && yt.privacyStatus && yt.privacyStatus !== "private") phase = "ALREADY_PUBLIC";
  else if (row.scheduledAt || (yt && yt.publishAt)) phase = "ALREADY_SCHEDULED";
  else if (!qaId) phase = "QA_INVALID";
  else if (!yt) phase = "CONFIG_INVALID";
  else phase = checks.every((c) => c.ok) ? "ELIGIBLE_FOR_SCHEDULING" : "PRIVATE_AWAITING_REVIEW";

  return { phase, checks, row, yt, qaId };
}

// ── CHECK ─────────────────────────────────────────────────────────────────

export interface CheckOutput {
  eligibility: Eligibility;
  slot: SlotDecision | null;
  requestedIso: string | null;
}

export async function doCheck(
  deps: PubDeps, policy: ChannelPolicy, rowId: string, publishAtLocal: string | null,
): Promise<CheckOutput> {
  const e = await evaluateEligibility(deps, policy, rowId);
  deps.log(`── PUBLICATION CONTROL — CHECK (${policy.key})`);
  deps.log(`   row ${rowId}  youtube ${e.row?.youtubeId ?? "n/a"}`);
  for (const c of e.checks) deps.log(`   ${c.ok ? "✓" : "✗"} ${c.label.padEnd(44)} ${c.detail}`);
  deps.log(`   durable scheduledAt : ${e.row?.scheduledAt?.toISOString() ?? "null"}`);
  deps.log(`   YouTube privacy     : ${e.yt?.privacyStatus ?? "unknown"}`);
  deps.log(`   YouTube publishAt   : ${e.yt?.publishAt ?? "none"}`);
  deps.log(`   final QA            : ${e.qaId ?? "NOT ACCEPTED"}`);
  deps.log(`   human approval      : NOT YET ASSERTED (CHECK never schedules)`);

  let slot: SlotDecision | null = null;
  let requestedIso: string | null = null;
  if (publishAtLocal) {
    const when = parseZoned(publishAtLocal, policy.timezone);
    if (!when) slot = { ok: false, code: "SLOT_UNPARSEABLE", detail: `cannot parse "${publishAtLocal}"` };
    else {
      requestedIso = when.toISOString();
      const occupied = (await deps.futureScheduled(policy.model, deps.now())).map((r) => r.scheduledAt);
      slot = validateSlot(when, deps.now(), policy, occupied);
    }
    deps.log(`   requested slot      : ${slot.ok ? "✓" : "✗"} ${slot.code} — ${slot.detail}`);
  }
  deps.log(`   PHASE               : ${e.phase}`);
  return { eligibility: e, slot, requestedIso };
}

// ── SCHEDULE ──────────────────────────────────────────────────────────────

export type ScheduleOutcome =
  | "SCHEDULED"
  | "REFUSED"
  | "RECONCILIATION_REQUIRED"
  | "READBACK_MISMATCH"
  | "YOUTUBE_WRITE_FAILED";

export interface ScheduleResult {
  outcome: ScheduleOutcome;
  reason: string;
  publishAtIso: string | null;
  ytWritten: boolean;
  dbWritten: boolean;
}

/**
 * The single guarded YouTube mutation.
 *
 * Ordering is YouTube-first, then read-back, then the durable row. YouTube is
 * the authority on whether a video is scheduled; a durable row written first
 * would claim a schedule that might not exist. If the DB write fails after a
 * confirmed YouTube schedule, the result is RECONCILIATION_REQUIRED — and a
 * blind retry cannot double-schedule, because the pre-flight reads YouTube and
 * finds the publishAt already set, which lands in ALREADY_SCHEDULED.
 *
 * The update sends part=["status"] ONLY, with the current status merged rather
 * than replaced, so title, description, tags, category and thumbnail cannot be
 * touched and unrelated status fields cannot be reset to defaults.
 */
export async function doSchedule(
  deps: PubDeps, policy: ChannelPolicy, rowId: string,
  publishAtLocal: string | null, approved: boolean,
): Promise<ScheduleResult> {
  const no = (outcome: ScheduleOutcome, reason: string): ScheduleResult =>
    ({ outcome, reason, publishAtIso: null, ytWritten: false, dbWritten: false });

  if (!approved) return no("REFUSED", "--i-have-reviewed-and-approved-this-video is required");
  if (!rowId) return no("REFUSED", "an exact --video row id is required");
  if (!publishAtLocal) return no("REFUSED", "--publish-at is required; no slot is ever chosen automatically");

  const e = await evaluateEligibility(deps, policy, rowId);
  if (e.phase !== "ELIGIBLE_FOR_SCHEDULING") {
    return no("REFUSED", `phase is ${e.phase}, expected ELIGIBLE_FOR_SCHEDULING`);
  }
  const row = e.row!, yt = e.yt!;

  const when = parseZoned(publishAtLocal, policy.timezone);
  if (!when) return no("REFUSED", `cannot parse --publish-at "${publishAtLocal}"`);
  const occupied = (await deps.futureScheduled(policy.model, deps.now())).map((r) => r.scheduledAt);
  const slot = validateSlot(when, deps.now(), policy, occupied);
  if (!slot.ok) return no("REFUSED", `${slot.code}: ${slot.detail}`);

  // Immediately before the write, re-assert the state we are transitioning FROM.
  const fresh = await deps.ytGetStatus(row.youtubeId!);
  if (!fresh) return no("REFUSED", "could not re-read YouTube status before writing");
  if (fresh.privacyStatus !== "private") {
    return no("REFUSED", `video is ${fresh.privacyStatus} on YouTube, not private — refusing to repair silently`);
  }
  if (fresh.publishAt) {
    return no("REFUSED", `video already carries publishAt ${fresh.publishAt} — refusing`);
  }

  const publishAtIso = when.toISOString();
  const merged = { ...fresh.rest, privacyStatus: "private", publishAt: publishAtIso };

  try {
    deps.log(`   ▸ videos.update part=["status"] id=${row.youtubeId} publishAt=${publishAtIso}`);
    await deps.ytSetStatus(row.youtubeId!, merged);
  } catch (err) {
    return { outcome: "YOUTUBE_WRITE_FAILED", publishAtIso,
      reason: `YouTube update failed: ${err instanceof Error ? err.message : String(err)}`,
      ytWritten: false, dbWritten: false };
  }

  const after = await deps.ytGetStatus(row.youtubeId!);
  if (!after || after.publishAt !== publishAtIso || after.privacyStatus !== "private") {
    return { outcome: "READBACK_MISMATCH", publishAtIso,
      reason: `read-back shows privacy=${after?.privacyStatus} publishAt=${after?.publishAt}`,
      ytWritten: true, dbWritten: false };
  }
  deps.log(`   ✓ read-back confirms private + publishAt ${publishAtIso}`);

  try {
    const rows = await deps.setScheduledAt(policy.model, row.id, when);
    if (rows !== 1) {
      return { outcome: "RECONCILIATION_REQUIRED", publishAtIso,
        reason: `YouTube is scheduled but the durable update matched ${rows} rows`,
        ytWritten: true, dbWritten: false };
    }
  } catch (err) {
    return { outcome: "RECONCILIATION_REQUIRED", publishAtIso,
      reason: `YouTube is scheduled but the durable write failed: ${err instanceof Error ? err.message : String(err)}`,
      ytWritten: true, dbWritten: false };
  }
  return { outcome: "SCHEDULED", reason: "scheduled and reconciled", publishAtIso,
    ytWritten: true, dbWritten: true };
}

// ── VERIFY (read-only reconciliation report) ──────────────────────────────

export interface VerifyResult {
  agreed: boolean;
  detail: string;
  ytPublishAt: string | null;
  dbScheduledAt: string | null;
}

export async function doVerify(deps: PubDeps, policy: ChannelPolicy, rowId: string): Promise<VerifyResult> {
  const row = await deps.readRow(policy.model, rowId);
  if (!row?.youtubeId) return { agreed: false, detail: "row or youtubeId missing", ytPublishAt: null, dbScheduledAt: null };
  const yt = await deps.ytGetStatus(row.youtubeId);
  const ytPublishAt = yt?.publishAt ?? null;
  const dbScheduledAt = row.scheduledAt ? row.scheduledAt.toISOString() : null;
  const agreed = ytPublishAt === dbScheduledAt;
  deps.log(`   YouTube publishAt : ${ytPublishAt ?? "none"}`);
  deps.log(`   durable scheduledAt: ${dbScheduledAt ?? "null"}`);
  deps.log(agreed ? "   ✓ in agreement" : "   ✗ DIVERGED — reconciliation required");
  return { agreed, detail: agreed ? "in agreement" : "diverged", ytPublishAt, dbScheduledAt };
}

// ── Real dependencies ─────────────────────────────────────────────────────

export function realDeps(): PubDeps {
  const p = prisma as unknown as Record<string, { findUnique: Function; findMany: Function; update: Function }>;
  const pilots = (prisma as never as { productionPilot: any }).productionPilot;
  return {
    readRow: (model, id) => p[model]!.findUnique({
      where: { id }, select: { id: true, youtubeId: true, status: true, scheduledAt: true, videoPath: true },
    }) as never,
    readPilot: (pilotId) => pilots.findUnique({
      where: { pilotId }, select: { successVideoIds: true, channel: true },
    }),
    readQa: (channel, videoId) => prisma.qaRecord.findMany({
      where: { videoId, channel, assetKind: "LONGFORM" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }) as never,
    unresolvedIntentCount: () => prisma.uploadIntent.count({
      where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
    }),
    futureScheduled: (model, after) => p[model]!.findMany({
      where: { scheduledAt: { gt: after } }, select: { id: true, scheduledAt: true },
    }) as never,
    async ytGetStatus(youtubeId) {
      const { buildYouTubeClient } = await import("@yt-pipeline/pipeline-core");
      const yt = (buildYouTubeClient as unknown as () => any)();
      const res = await yt.videos.list({ part: ["status"], id: [youtubeId] });
      const s = res.data.items?.[0]?.status;
      if (!s) return null;
      const { privacyStatus = null, publishAt = null, ...rest } = s as Record<string, unknown>;
      return { privacyStatus: privacyStatus as string | null, publishAt: publishAt as string | null, rest };
    },
    async ytSetStatus(youtubeId, status) {
      const { buildYouTubeClient } = await import("@yt-pipeline/pipeline-core");
      const yt = (buildYouTubeClient as unknown as () => any)();
      await yt.videos.update({ part: ["status"], requestBody: { id: youtubeId, status } });
    },
    setScheduledAt: (model, id, at) =>
      p[model]!.update({ where: { id }, data: { scheduledAt: at } }).then(() => 1) as never,
    async fileSha256(path) {
      if (!path || !existsSync(path)) return null;
      return new Promise((res, rej) => {
        const h = createHash("sha256");
        createReadStream(path).on("data", (c) => h.update(c)).on("error", rej)
          .on("end", () => res(h.digest("hex")));
      });
    },
    now: () => new Date(),
    log: (l) => console.log(l),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────

export function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

export function selectedMode(argv: string[]): "SCHEDULE" | "VERIFY" | "CHECK" | "AMBIGUOUS" {
  const picked = [argv.includes("--schedule") && "SCHEDULE", argv.includes("--verify") && "VERIFY"]
    .filter(Boolean) as string[];
  if (picked.length > 1) return "AMBIGUOUS";
  return (picked[0] as never) ?? "CHECK";
}


/**
 * Reject anything not in the flag surface.
 *
 * Every mode here falls through to a read-only CHECK when no mode flag matches,
 * which is safe but silent: a mistyped `--arm` produced a clean CHECK report
 * that an operator could easily read as "it armed". Refusing the command is the
 * only outcome that cannot be misread.
 */
function assertKnownFlags(argv: string[], known: string[]): boolean {
  const unknown = argv.slice(2).filter((a) => a.startsWith("--") && !known.includes(a));
  if (unknown.length === 0) return true;
  console.error(`\u2717 unrecognised flag(s): ${unknown.join(" ")}`);
  console.error(`  known flags: ${known.join(" ")}`);
  process.exitCode = 2;
  return false;
}

async function main(): Promise<void> {
  if (!assertKnownFlags(process.argv, ["--channel", "--i-have-reviewed-and-approved-this-video", "--publish-at", "--schedule", "--verify", "--video"])) return;
  const argv = process.argv;
  const mode = selectedMode(argv);
  if (mode === "AMBIGUOUS") { console.error("✗ more than one mode flag — refusing"); process.exitCode = 2; return; }

  const channel = argValue(argv, "--channel") as ChannelKey | null;
  if (!channel || !POLICIES[channel]) {
    console.error("✗ --channel must be ai-doom-scroll or wet-circuit"); process.exitCode = 2; return;
  }
  const policy = POLICIES[channel];
  const rowId = argValue(argv, "--video");
  if (!rowId) { console.error("✗ --video <durable row id> is required"); process.exitCode = 2; return; }

  const deps = realDeps();
  const publishAt = argValue(argv, "--publish-at");

  if (mode === "CHECK") { await doCheck(deps, policy, rowId, publishAt); return; }
  if (mode === "VERIFY") { const r = await doVerify(deps, policy, rowId); if (!r.agreed) process.exitCode = 1; return; }

  const r = await doSchedule(deps, policy, rowId, publishAt,
    argv.includes("--i-have-reviewed-and-approved-this-video"));
  console.log(`\n  OUTCOME: ${r.outcome}\n  reason : ${r.reason}\n  publishAt: ${r.publishAtIso ?? "n/a"}`);
  console.log(`  youtube written: ${r.ytWritten}   durable written: ${r.dbWritten}`);
  if (r.outcome !== "SCHEDULED") process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("video-publication-control.ts") ||
  process.argv[1]?.endsWith("video-publication-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
