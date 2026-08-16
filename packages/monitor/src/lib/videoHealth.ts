/**
 * First-week video health checks.
 *
 * The existing monitor watches performance — views, comments, lifecycle,
 * Reddit. It does not watch whether a video we scheduled actually exists, is
 * scheduled for the time we think, and actually went live. Those are the
 * questions that matter in the first production week, and none of them were
 * covered: the monitor never reads `uploadIntent`, never compares YouTube's
 * `publishAt` to the durable `scheduledAt`, and never notices a scheduled video
 * that stayed private.
 *
 * Everything here is PURE and READ-ONLY. No YouTube write, no database write,
 * no pipeline trigger. It is deliberately NOT wired into the monitor's tick
 * loop: those services are live, and adding behaviour to a running service is a
 * separate, controlled decision. A local operator script consumes this today.
 *
 * Deliberately absent: any judgement about pilots being PREPARED, ACTIVE or
 * private. Those are designed states, not incidents, and alerting on them would
 * make the first week pure noise.
 */

export type Severity = "OK" | "WARN" | "ALERT";

export interface HealthFinding {
  code: string;
  severity: Severity;
  subject: string;
  detail: string;
}

/**
 * Grace period between a scheduled publish time and declaring that a video
 * failed to go live.
 *
 * OPERATIONAL constant, not a content or business threshold: YouTube does not
 * flip a video public at the exact second, and the monitor polls hourly. No
 * repository policy defines this value, so it is set conservatively short
 * enough to catch a genuine failure within one poll and long enough that normal
 * propagation never trips it.
 */
export const GO_LIVE_GRACE_MS = 15 * 60 * 1000;

export interface ScheduledVideo {
  id: string;
  youtubeId: string | null;
  status: string;
  scheduledAt: Date | null;
}

export interface YtView {
  exists: boolean;
  privacyStatus: string | null;
  publishAt: string | null;
}

/**
 * A. Scheduled-video health, and B. go-live health.
 *
 * Before the scheduled time the video must exist and be private with a
 * `publishAt` matching the durable `scheduledAt`. After the grace period it must
 * be public.
 */
export function checkScheduledVideo(
  video: ScheduledVideo, yt: YtView | null, now: Date,
  graceMs: number = GO_LIVE_GRACE_MS,
): HealthFinding[] {
  const out: HealthFinding[] = [];
  const subject = `${video.id}${video.youtubeId ? ` (${video.youtubeId})` : ""}`;

  if (!video.scheduledAt) return out; // nothing scheduled: not this check's business

  if (!video.youtubeId) {
    out.push({ code: "SCHEDULED_WITHOUT_YOUTUBE_ID", severity: "ALERT", subject,
      detail: "durable row has scheduledAt but no youtubeId" });
    return out;
  }
  if (!yt || !yt.exists) {
    out.push({ code: "YOUTUBE_VIDEO_MISSING", severity: "ALERT", subject,
      detail: `scheduled for ${video.scheduledAt.toISOString()} but YouTube has no such video` });
    return out;
  }

  const due = video.scheduledAt.getTime();
  const nowMs = now.getTime();

  // publishAt agreement matters only while it should still be set.
  if (nowMs < due) {
    if (!yt.publishAt) {
      out.push({ code: "PUBLISH_AT_MISSING", severity: "ALERT", subject,
        detail: `durable scheduledAt ${video.scheduledAt.toISOString()} but YouTube carries no publishAt` });
    } else if (new Date(yt.publishAt).getTime() !== due) {
      out.push({ code: "PUBLISH_AT_DIVERGED", severity: "ALERT", subject,
        detail: `YouTube publishAt ${yt.publishAt} != durable ${video.scheduledAt.toISOString()}` });
    }
    if (yt.privacyStatus && yt.privacyStatus !== "private") {
      out.push({ code: "PUBLIC_BEFORE_SCHEDULE", severity: "ALERT", subject,
        detail: `privacy is ${yt.privacyStatus} before its ${video.scheduledAt.toISOString()} slot` });
    }
    return out;
  }

  // Past the slot. Inside grace, say nothing — propagation is not an incident.
  if (nowMs < due + graceMs) return out;

  if (yt.privacyStatus !== "public") {
    out.push({ code: "FAILED_TO_GO_LIVE", severity: "ALERT", subject,
      detail: `still ${yt.privacyStatus ?? "unknown"} ${Math.round((nowMs - due) / 60000)} min after ` +
        `${video.scheduledAt.toISOString()} (grace ${graceMs / 60000} min)` });
  }
  return out;
}

/** C. Upload safety. */
export function checkUploadSafety(unresolvedIntents: number): HealthFinding[] {
  if (unresolvedIntents <= 0) return [];
  return [{ code: "UNRESOLVED_UPLOAD_INTENT", severity: "ALERT", subject: "uploadIntent",
    detail: `${unresolvedIntents} intent(s) not PERSISTED/RECONCILED — a video may exist that we have not recorded` }];
}

export interface RunView {
  id: string; status: string; startTime: Date; endTime: Date | null;
  /**
   * Durable evidence about what this run actually DID, so a terminal FAILED can
   * be told apart from an incident. Undefined means "not supplied", which is
   * treated as unknown and therefore blocking — a caller that cannot produce
   * the evidence must not get the benefit of the doubt.
   */
  evidence?: RunSpendEvidence;
}

/**
 * What a run touched, from the systems that actually record it.
 *
 * Deliberately narrow and all durable: narration accounting, reservations, the
 * render artifact, upload intents and the published id. No proxies, no
 * inference from stage names.
 */
export interface RunSpendEvidence {
  /** Rows in elevenlabs_usage attributable to this run or its candidate. */
  narrationRows: number;
  /** Characters still reserved against the channel's budget. */
  reservedChars: number;
  /** The candidate reached a terminal FAILED state rather than being mid-flight. */
  candidateTerminal: boolean;
  /** A render artifact exists on the candidate. */
  hasRenderArtifact: boolean;
  uploadIntents: number;
  youtubeId: string | null;
  scheduledAt: Date | null;
}

export type RunClassification =
  | { blocking: false; spent: boolean; reason: string }
  | { blocking: true; reason: string };

/**
 * Did this failed run stop before doing anything irreversible?
 *
 * A candidate refused by a deliberate pre-spend gate — quality, script length,
 * visual feasibility — is the safety system working, not an incident. Treating
 * it identically to a failure after spend meant one safe rejection locked
 * production out for the 24 hours the finding lived, which is an operational
 * cost with no safety benefit.
 *
 * The distinction is drawn from durable accounting, never from `status`, never
 * from the stage name. Every piece of evidence must be present AND clean;
 * anything missing, ambiguous or non-zero blocks. Unknown stays unhealthy.
 */
export function classifyFailedRun(r: RunView): RunClassification {
  const e = r.evidence;
  if (!e) {
    return { blocking: true, reason: "no spend evidence available — cannot prove where it stopped" };
  }
  // Ambiguity first: anything that might have left state behind, in the order
  // it would matter to a human. Each of these means we cannot say exactly what
  // happened, and that is what a blocking finding is for.
  if (!e.candidateTerminal) {
    return { blocking: true, reason: "candidate is not in a terminal state" };
  }
  if (e.reservedChars > 0) {
    return { blocking: true, reason: `${e.reservedChars} char(s) still reserved — settle before another run` };
  }
  if (e.hasRenderArtifact) {
    return { blocking: true, reason: "a render artifact exists — the run went past the pre-spend boundary" };
  }
  if (e.uploadIntents > 0) {
    return { blocking: true, reason: `${e.uploadIntents} upload intent(s) — an upload may have happened` };
  }
  if (e.youtubeId) {
    return { blocking: true, reason: `youtubeId ${e.youtubeId} exists — a video may be on the channel` };
  }
  if (e.scheduledAt) {
    return { blocking: true, reason: `carries a publish time ${e.scheduledAt.toISOString()}` };
  }

  // Everything is settled and nothing shipped. If narration was bought, that is
  // a COST, not an incident: the money is already gone, no state is ambiguous,
  // and blocking the channel recovers nothing while stopping work that is still
  // authorised. It is recorded prominently — with the row count — so it can
  // never be mistaken for a free failure, and the controller reports it as
  // FAILED_AFTER_SPEND.
  //
  // Narration used to be checked FIRST and blocked unconditionally, which was
  // written when every imaginable post-spend failure was an ambiguous one. A
  // deterministic assembly rejection is not, and on 2026-08-16 that rule would
  // have locked a live tranche out for 24 hours over an invariant that had
  // already done its job.
  if (e.narrationRows > 0) {
    return {
      blocking: false, spent: true,
      reason: `${e.narrationRows} narration usage row(s) charged, then failed before upload — ` +
        "nothing rendered, no upload intent, no video, reservation settled",
    };
  }
  return {
    blocking: false, spent: false,
    reason: "no narration, no reservation, no render, no upload intent, no video — " +
      "rejected before anything irreversible",
  };
}

/** D. Pipeline health. */
export function checkPipelineHealth(
  runs: RunView[], now: Date, stuckAfterMs = 60 * 60 * 1000,
): HealthFinding[] {
  const out: HealthFinding[] = [];
  for (const r of runs) {
    if (!r.endTime) {
      const age = now.getTime() - r.startTime.getTime();
      if (age > stuckAfterMs) {
        out.push({ code: "RUN_STUCK", severity: "ALERT", subject: r.id,
          detail: `active for ${Math.round(age / 60000)} min with no end time` });
      }
      continue;
    }
    if (r.status === "FAILED" || r.status === "CRITICAL") {
      const c = classifyFailedRun(r);
      if (c.blocking) {
        out.push({ code: "RUN_FAILED", severity: "ALERT", subject: r.id,
          detail: `terminal status ${r.status} at ${r.endTime.toISOString()} — ${c.reason}` });
      } else {
        // Recorded and visible, but not an active finding. Either a gate
        // refused the candidate before it could spend, or narration was bought
        // and the run then failed deterministically with nothing left behind.
        out.push({
          code: c.spent ? "CANDIDATE_FAILED_AFTER_SPEND" : "CANDIDATE_REJECTED_BEFORE_SPEND",
          severity: "OK", subject: r.id,
          detail: `terminal status ${r.status} at ${r.endTime.toISOString()} — ${c.reason}` });
      }
    }
  }
  return out;
}

export interface BudgetView { key: string; limit: number; reserved: number }

/**
 * Budget anomalies while idle.
 *
 * A non-zero reservation with no run in flight means a narration window was
 * opened and never settled. A controlled limit above zero while idle means a
 * spend window was left open — both are money-shaped, so both alert.
 */
export function checkIdleBudget(rows: BudgetView[], activeRuns: number): HealthFinding[] {
  const out: HealthFinding[] = [];
  for (const r of rows) {
    if (r.reserved > 0 && activeRuns === 0) {
      out.push({ code: "STALE_RESERVATION", severity: "ALERT", subject: r.key,
        detail: `${r.reserved} chars reserved with no active run` });
    }
    if (r.limit > 0 && activeRuns === 0) {
      out.push({ code: "BUDGET_OPEN_WHILE_IDLE", severity: "ALERT", subject: r.key,
        detail: `limit ${r.limit} with no active run — a spend window was left open` });
    }
  }
  return out;
}

export interface PilotView {
  pilotId: string; status: string; successCount: number; maxSuccesses: number;
  successVideoIds: string[];
}

/**
 * E. Pilot consistency — impossible states only.
 *
 * PREPARED, ACTIVE, private and capped are all designed states and never alert.
 * What alerts is arithmetic that cannot be true.
 */
export function checkPilotConsistency(p: PilotView): HealthFinding[] {
  const out: HealthFinding[] = [];
  if (p.successCount > p.maxSuccesses) {
    out.push({ code: "PILOT_CAP_EXCEEDED", severity: "ALERT", subject: p.pilotId,
      detail: `${p.successCount}/${p.maxSuccesses} — more successes than the cap allows` });
  }
  if (p.successVideoIds.length > p.successCount) {
    out.push({ code: "PILOT_COUNT_MISMATCH", severity: "ALERT", subject: p.pilotId,
      detail: `${p.successVideoIds.length} confirmed video(s) but only ${p.successCount} claimed` });
  }
  if (p.successCount < 0 || p.maxSuccesses < 0) {
    out.push({ code: "PILOT_NEGATIVE", severity: "ALERT", subject: p.pilotId,
      detail: `negative counters: ${p.successCount}/${p.maxSuccesses}` });
  }
  return out;
}

export interface HealthInput {
  channel: string;
  scheduled: { video: ScheduledVideo; yt: YtView | null }[];
  unresolvedIntents: number;
  runs: RunView[];
  budgets: BudgetView[];
  activeRuns: number;
  pilots: PilotView[];
  now: Date;
  graceMs?: number;
}

export interface HealthReport {
  channel: string;
  findings: HealthFinding[];
  healthy: boolean;
}

/** Whole-channel evaluation. Pure: same input, same report, no side effects. */
export function evaluateChannelHealth(input: HealthInput): HealthReport {
  const findings: HealthFinding[] = [];
  for (const s of input.scheduled) {
    findings.push(...checkScheduledVideo(s.video, s.yt, input.now, input.graceMs));
  }
  findings.push(...checkUploadSafety(input.unresolvedIntents));
  findings.push(...checkPipelineHealth(input.runs, input.now));
  findings.push(...checkIdleBudget(input.budgets, input.activeRuns));
  for (const p of input.pilots) findings.push(...checkPilotConsistency(p));
  return {
    channel: input.channel,
    findings,
    healthy: findings.every((f) => f.severity === "OK"),
  };
}
