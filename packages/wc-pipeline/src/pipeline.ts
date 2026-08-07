import { join } from "node:path";
import { rm } from "node:fs/promises";
import { TopicStatus, VideoStatus } from "@prisma/client";
import {
  prisma,
  disconnect,
  withAdvisoryLock,
  withRetry,
  quarantinedVideoIds,
  env,
  RunSummary,
  currentPilot, assertRunnable, remainingSlots, PilotBlockedError,
  formatZoned, isInWindow,
  buildSpokenUnits, spokenCharacterCount,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "@yt-pipeline/pipeline-core";

import { topicDiscovery } from "./stages/topicDiscovery";
import { scriptGenerator } from "./stages/scriptGenerator";
import { qualityGate } from "./stages/qualityGate";
import { wcVisualFeasibilityGate } from "./stages/visualFeasibilityGate";
import { seoGenerator } from "./stages/seoGenerator";
import { wcThumbnailGenerator } from "./stages/thumbnailGenerator";
import { wcThumbnailHeadlineGenerator } from "./stages/thumbnailHeadlineGenerator";
import { wcVoiceover } from "./stages/voiceover";
import { wcVideoAssembly } from "./stages/videoAssembly";
import { wcFinalVideoQa } from "./stages/finalVideoQa";
import { wcYoutubeUpload } from "./stages/youtubeUpload";
import { wcShortsGenerator } from "./stages/shortsGenerator";
import { wcNotify } from "./stages/notify";
import {
  findWcCanaryAuthorization, assertWcCanaryWindow, resolveWcCanaryAuthorization,
} from "./canary/authorization";

// ── Constants ─────────────────────────────────────────────────────────────

/** Wet Circuit YouTube channel */
const WC_CHANNEL_ID = "UC9iJDqlrKEs0uuMeIjb9DVA";

/** Separate advisory lock ID so wc-pipeline doesn't block yt-pipeline */
const WC_LOCK_ID = 789012;

// ── Stage definitions (sequential) ────────────────────────────────────────
//
// Order: discover → script → quality gate → visual feasibility → SEO →
//        thumbnail → voiceover → assembly → upload → shorts → notify
// SEO + thumbnails run before voiceover because they only need the script, not audio.

const STAGES: StageDefinition[] = [
  { name: "topicDiscovery",               execute: topicDiscovery,               retries: 2 },
  { name: "scriptGenerator",              execute: scriptGenerator,              retries: 2 },
  { name: "qualityGate",                  execute: qualityGate,                  retries: 0 },
  // Before ANY ElevenLabs budget opens. A retry here would re-query the stock
  // library for the same verdict, so it gets none.
  { name: "visualFeasibilityGate",        execute: wcVisualFeasibilityGate,      retries: 0 },
  { name: "seoGenerator",                 execute: seoGenerator,                 retries: 2 },
  { name: "wcThumbnailHeadlineGenerator", execute: wcThumbnailHeadlineGenerator, retries: 2 },
  { name: "wcThumbnailGenerator",         execute: wcThumbnailGenerator,         retries: 2 },
  { name: "voiceover",                    execute: wcVoiceover,                  retries: 3 },
  { name: "videoAssembly",                execute: wcVideoAssembly,              retries: 3 },
  // Validates the assembled video and its captions, and binds the verdict to
  // the artifact's hash. A retry would re-measure the same bytes for the same
  // answer, so it gets none.
  { name: "finalVideoQa",                 execute: wcFinalVideoQa,               retries: 0 },
  { name: "youtubeUpload",                execute: wcYoutubeUpload,              retries: 3 },
  // Skipped during a pilot: a Short is a second video and a second upload,
  // neither of which a one-video canary authorises. Gated by the durable pilot
  // config rather than by commenting the stage out, so ordinary production
  // keeps it.
  { name: "shortsGenerator",              execute: wcShortsGenerator,            retries: 1, skipDuringPilot: true },
  { name: "notify",                       execute: wcNotify,                     retries: 2 },
];

/**
 * Where a stuck video resumes, BY STAGE NAME.
 *
 * These used to be numeric indices into STAGES, carrying a comment tracking how
 * far they had shifted the last time a stage was inserted. Adding
 * visualFeasibilityGate would have shifted every one of them again, silently
 * resuming a narrated video at the wrong stage — and a pilot run, which filters
 * shortsGenerator out, shifts them differently again. Names cannot drift.
 *
 * Deliberately NOT included: VOICEOVER_PENDING / SCRIPT_PENDING / SEO_PENDING.
 * Auto-resuming those would re-spend ElevenLabs / Anthropic credits — the
 * operator must decide.
 */
const RESUME_FROM: Partial<Record<VideoStatus, string>> = {
  [VideoStatus.SEO_DONE]:         "wcThumbnailHeadlineGenerator",
  [VideoStatus.VOICEOVER_DONE]:   "videoAssembly",
  // Assembly finished but upload had not started: re-run QA against whatever
  // artifact is on disk now, rather than trusting a verdict from a previous
  // render. Resuming straight to youtubeUpload would be refused anyway, since
  // the upload gate compares the artifact's hash to the persisted one.
  [VideoStatus.ASSEMBLY_DONE]:    "finalVideoQa",
  // Mid-stage crash recovery (container died between status update and stage
  // completion). Safe to auto-retry: these stages make no paid API calls.
  [VideoStatus.ASSEMBLY_PENDING]: "videoAssembly",
  [VideoStatus.UPLOAD_PENDING]:   "youtubeUpload",
};

/** Fails closed rather than resuming at an arbitrary stage. */
function resumeIndex(stages: StageDefinition[], status: VideoStatus): number {
  const name = RESUME_FROM[status];
  const idx = name ? stages.findIndex((s) => s.name === name) : -1;
  if (idx < 0) throw new Error(`no resume stage named "${name}" for status ${status}`);
  return idx;
}

// ── Halt-on-failure guard ───────────────────────────────────────────────
// Window beyond which an unacknowledged FAILED row stops blocking new work.
// Operator can also acknowledge sooner by prefixing failReason with "[ack]".
const FAILURE_HALT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────

const LOG = "[wc:pipeline]";

function ts(): string {
  return new Date().toISOString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

async function failVideo(
  ctx: PipelineContext,
  stageName: string,
  reason: string,
) {
  const failReason = `${stageName}: ${reason}`;
  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      status: VideoStatus.FAILED,
      failReason,
      retryCount: { increment: 1 },
    },
  });
  ctx.video = { ...ctx.video, failReason };

  // Best-effort failure notification
  await wcNotify(ctx).catch(() => {});
}

async function cleanupTmpDir(videoId: string): Promise<void> {
  const tmpDir = join(process.cwd(), "tmp", videoId);
  try {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`${LOG} Cleaned up ${tmpDir}`);
  } catch {
    // non-fatal
  }
}

/**
 * Run a sequence of stages, aborting on first failure.
 * Returns true if all stages succeeded.
 */
async function runStages(
  stages: StageDefinition[],
  ctx: PipelineContext,
  summary?: RunSummary,
): Promise<boolean> {
  for (const stage of stages) {
    const stageStart = Date.now();
    console.log(`${LOG} ▸ ${stage.name} started at ${ts()}`);

    let result: StageResult;
    try {
      result = await withRetry(() => stage.execute(ctx), {
        maxRetries: stage.retries,
        label: stage.name,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} ✗ ${stage.name} threw: ${reason}`);
      console.log(`${LOG} ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`);
      summary?.markFailed(stage.name, err);
      await failVideo(ctx, stage.name, reason);
      return false;
    }

    if (!result.success) {
      console.error(`${LOG} ✗ ${stage.name} rejected: ${result.error}`);
      console.log(`${LOG} ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`);
      summary?.markFailed(stage.name, new Error(result.error ?? "unknown error"));
      await failVideo(ctx, stage.name, result.error ?? "unknown error");
      return false;
    }

    console.log(`${LOG} ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`);
  }

  return true;
}

/**
 * Populate summary outputs from the final state of a WcVideo DB row +
 * run runMode-aware output verification. Called at the successful end of
 * either the resume path or the fresh-pipeline path.
 */
async function finalizeSummary(
  summary: RunSummary | undefined,
  videoDbId: string,
): Promise<void> {
  if (!summary) return;
  const v = await prisma.wcVideo.findUnique({ where: { id: videoDbId } });
  if (!v) return;
  summary.setVideoId(v.id);
  summary.setYoutubeId(v.youtubeId);
  summary.setScheduledAt(v.scheduledAt);
  summary.setShortsUrl(v.shortsUrl);
  summary.verifyOutputs({
    finalStatus: v.status,
    videoYoutubeId: v.youtubeId,
    videoScheduledAt: v.scheduledAt,
    videoShortsUrl: v.shortsUrl,
    thumbnailAPath: v.thumbnailA,
    assemblyCompleted: true,
  });
}

// ── Pilot gate ─────────────────────────────────────────────────────────────
//
// Every check reads the durable row, so a redeploy or a crash cannot reset what
// the pilot has already used. The advisory lock held by the caller is the first
// concurrency defence; the cap below fails closed independently of it, because
// a lock that is somehow not held must not become permission to exceed the
// limit.
//
// Shared by both entry points. The ordinary runner and the explicit one-shot
// canary runner must not be able to drift apart on what a pilot permits: a
// second copy of these checks is a second place for one of them to be missed.
// Callers must already hold WC_LOCK_ID.
async function pilotGate(): Promise<PilotConfig | null> {
  const pilot = await currentPilot();
  if (!pilot) return null;

  if (pilot.channel !== "wet-circuit" || pilot.channelId !== WC_CHANNEL_ID) {
    throw new PilotBlockedError(
      "PILOT_WRONG_CHANNEL",
      `pilot ${pilot.pilotId} is for ${pilot.channel} (${pilot.channelId}), ` +
      `not wet-circuit (${WC_CHANNEL_ID}) — refusing to run it here`,
    );
  }
  console.log(
    `${LOG} PILOT ${pilot.pilotId}: status=${pilot.status} ` +
    `${pilot.successVideoIds.length}/${pilot.maxSuccesses} confirmed, ` +
    `${pilot.successCount} claimed, shorts=${pilot.shortsEnabled ? "on" : "off"}, ` +
    `publishAt=${pilot.allowPublishAt ? "permitted" : "forbidden"}`,
  );
  assertRunnable(pilot);
  const left = await remainingSlots(pilot.pilotId);
  if (left <= 0) {
    throw new PilotBlockedError("PILOT_CAP_REACHED",
      `pilot ${pilot.pilotId} has no slots left — refusing to create a candidate`);
  }

  // ── Execution window ──────────────────────────────────────────────
  //
  // An AUTHORISED canary is refused outside its window. This used to log and
  // continue, which made the window advisory: a canary that may run at any hour
  // is not bounded. The refusal happens here, before any candidate row is
  // created or resumed, so it precedes budget reservation, narration, media
  // acquisition, rendering and upload.
  //
  // A pilot with no canary authorisation keeps the previous advisory behaviour,
  // so ordinary pilot use is unchanged.
  const canaryAuth = findWcCanaryAuthorization(pilot.pilotId);
  if (canaryAuth) {
    // Throws WcCanaryAuthorizationError outside the window.
    const decision = assertWcCanaryWindow(new Date(), canaryAuth);
    console.log(`${LOG} execution window OK — ${decision.nowLocal} (${decision.reason})`);
  } else if (!isInWindow(new Date(), {
    days: pilot.windowDays, startHour: pilot.windowStartHour,
    endHour: pilot.windowEndHour, timeZone: pilot.timezone,
  })) {
    console.log(
      `${LOG} outside the pilot execution window ` +
      `(${pilot.windowStartHour}:00-${pilot.windowEndHour}:00 ${pilot.timezone}); ` +
      `now is ${formatZoned(new Date(), pilot.timezone)}`,
    );
  }

  // An unresolved upload from a prior pilot candidate must be reconciled by a
  // human before another candidate is created: it may already be a video on the
  // channel.
  const unresolved = await prisma.uploadIntent.count({
    where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
  });
  if (unresolved > 0) {
    throw new PilotBlockedError("UNRESOLVED_INTENT",
      `${unresolved} unresolved upload intent(s) — reconcile before another pilot run`);
  }
  console.log(`${LOG} pilot slots remaining: ${left}`);
  return pilot;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runPipeline(summary?: RunSummary): Promise<void> {
  const pipelineStart = Date.now();
  console.log(`${LOG} ═══ Run started at ${ts()} ═══`);
  console.log(`${LOG} Channel: Wet Circuit (${WC_CHANNEL_ID})`);

  await withAdvisoryLock(prisma, WC_LOCK_ID, async () => {
    console.log(`${LOG} Advisory lock acquired (id: ${WC_LOCK_ID})`);

    const pilot = await pilotGate();
    const stages = STAGES.filter((s) => !(pilot && s.skipDuringPilot));
    if (pilot) {
      const skipped = STAGES.filter((s) => s.skipDuringPilot).map((s) => s.name);
      if (skipped.length) console.log(`${LOG} pilot skips: ${skipped.join(", ")}`);
    }

    // ── Halt-on-failure guard ────────────────────────────────────────
    // Refuse to start any new work (resume OR topicDiscovery) while there
    // are unacknowledged recent LIVE FAILED videos. DRY_RUN failures are
    // stored and visible but do NOT block — they're expected during
    // validation and shouldn't require manual acknowledgement.
    // To clear a LIVE failure: prefix failReason with "[ack]" (or wait
    // out the 24h window, or change status away from FAILED).
    const unackFailures = await prisma.wcVideo.findMany({
      where: {
        status: VideoStatus.FAILED,
        runMode: "LIVE",
        updatedAt: { gte: new Date(Date.now() - FAILURE_HALT_WINDOW_MS) },
        NOT: { failReason: { startsWith: "[ack]" } },
      },
      select: { id: true, failReason: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });

    if (unackFailures.length > 0) {
      console.warn(
        `${LOG} HALT: ${unackFailures.length} unacknowledged LIVE WC failure(s) within ${FAILURE_HALT_WINDOW_MS / 3600000}h:`,
      );
      for (const f of unackFailures) {
        console.warn(
          `${LOG}   - ${f.id} @ ${f.updatedAt.toISOString()}: ${(f.failReason ?? "").slice(0, 120)}`,
        );
      }
      console.warn(
        `${LOG} To proceed: retry by setting status to a stuck state (SEO_DONE/VOICEOVER_DONE/ASSEMBLY_DONE), or acknowledge by prefixing failReason with "[ack]".`,
      );
      summary?.addWarning(
        `halt-blocked: ${unackFailures.length} unacknowledged LIVE failure(s) within ${FAILURE_HALT_WINDOW_MS / 3600000}h`,
      );
      return;
    }

    // ── Check for stuck videos that can be resumed ────────────────────

    const resumableStatuses = Object.keys(RESUME_FROM) as VideoStatus[];
    // Quarantined jobs are excluded explicitly as well as by status, so
    // restoring a row's status by hand cannot silently re-arm it.
    const quarantined = await quarantinedVideoIds();
    if (quarantined.length > 0) {
      console.log(`${LOG} ${quarantined.length} quarantined job(s) excluded from resume`);
    }
    const stuckVideo = await prisma.wcVideo.findFirst({
      where: {
        status: { in: resumableStatuses },
        id: { notIn: quarantined.length ? quarantined : ["__none__"] },
      },
      include: { topic: true },
      orderBy: { updatedAt: "asc" }, // oldest stuck video first
    });

    if (stuckVideo) {
      const resumeStages = stages.slice(resumeIndex(stages, stuckVideo.status));
      console.log(
        `${LOG} Resuming video ${stuckVideo.id} (stuck at ${stuckVideo.status}) from ${resumeStages[0].name}`,
      );
      summary?.setVideoId(stuckVideo.id);

      // Rebuild context from DB fields
      const ctx: PipelineContext = {
        topic: stuckVideo.topic,
        video: stuckVideo,
        script: (stuckVideo.scriptJson as unknown as Script) ?? undefined,
        voiceoverUrls: stuckVideo.voiceoverUrls,
        videoUrl: stuckVideo.videoPath ?? undefined,
        seo:
          stuckVideo.seoTitle && stuckVideo.seoDescription
            ? {
                title: stuckVideo.seoTitle,
                description: stuckVideo.seoDescription,
                tags: stuckVideo.seoTags,
                chapters: (stuckVideo.seoChapters as unknown as SEOMetadata["chapters"]) ?? [],
              }
            : undefined,
      };

      const ok = await runStages(resumeStages, ctx, summary);
      if (ok) {
        await cleanupTmpDir(ctx.video.id);
        await finalizeSummary(summary, ctx.video.id);
        console.log(`${LOG} ✓ Resumed complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`);
      }
      return;
    }

    // ── Stage 1: Topic Discovery (seeds the context) ──────────────────

    const discoveryStage = stages[0];
    const discoveryStart = Date.now();
    console.log(`${LOG} ▸ ${discoveryStage.name} started at ${ts()}`);

    let discoveryResult: StageResult;
    try {
      discoveryResult = await withRetry(
        () => topicDiscovery({} as PipelineContext),
        { maxRetries: discoveryStage.retries, label: discoveryStage.name },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} ✗ topicDiscovery failed: ${msg}`);
      console.log(`${LOG} ▸ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`);
      summary?.markFailed("topicDiscovery", err);
      return;
    }

    console.log(`${LOG} ✓ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`);

    if (!discoveryResult.success || !discoveryResult.data) {
      console.log(`${LOG} Discovery found no new topics, checking for existing APPROVED topics…`);

      const fallbackTopic = await prisma.wcTopic.findFirst({
        where: {
          status: TopicStatus.APPROVED,
          videos: { none: {} },
        },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      });

      if (!fallbackTopic) {
        console.log(`${LOG} No APPROVED fallback topics either, exiting`);
        summary?.markIdle();
        return;
      }

      console.log(`${LOG} Using fallback APPROVED topic: "${fallbackTopic.title}"`);
      discoveryResult = { success: true, data: fallbackTopic, durationMs: discoveryResult.durationMs };
    }

    const topic = discoveryResult.data as PipelineContext["topic"];

    // Create a video record to track through the pipeline.
    // runMode tags the row so DRY_RUN failures don't trigger the halt guard.
    const runMode = process.env.DISABLE_ELEVEN === "true" ? "DRY_RUN" : "LIVE";
    const video = await prisma.wcVideo.create({
      data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, runMode },
    });

    const ctx: PipelineContext = { topic, video };
    summary?.setVideoId(video.id);
    console.log(`${LOG} Video ${video.id} created for topic "${topic.title}"`);

    // ── Stages 2–8 (scriptGenerator → notify) ─────────────────────────

    const ok = await runStages(stages.slice(1), ctx, summary);
    if (ok) {
      await cleanupTmpDir(ctx.video.id);
      await finalizeSummary(summary, ctx.video.id);
      console.log(`${LOG} ✓ Complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`);
    }
  });

  console.log(`${LOG} ═══ Run finished at ${ts()} — total ${fmtDuration(Date.now() - pipelineStart)} ═══`);
}

// ── Explicit one-shot canary execution ─────────────────────────────────────

/**
 * Stage the one-shot canary re-enters at.
 *
 * `visualFeasibilityGate`, NOT `voiceover`. The armed candidate is exactly where
 * `qualityGate` leaves a passing script — the gate sets VOICEOVER_PENDING and
 * feasibility runs next — so feasibility is the first stage that has not yet run
 * for it, and re-entering later would skip it.
 *
 * This ordering is the whole pre-spend contract. Narration budget is opened
 * inside the `voiceover` stage itself, so a gate that runs before `voiceover`
 * runs before any window can open: a feasibility failure costs zero characters,
 * because nothing has been reserved yet when it fails. Starting at `voiceover`
 * would have skipped feasibility, SEO and both thumbnail stages and gone
 * straight into the stage that opens the budget.
 */
const CANARY_START_STAGE = "visualFeasibilityGate";

/**
 * Run ONE already-prepared candidate, addressed by id, exactly once.
 *
 * The ordinary runner cannot start the private canary, and must not be taught
 * to. The prepared candidate sits at VOICEOVER_PENDING, which RESUME_FROM
 * deliberately excludes, so runPipeline() does not select it — it falls through
 * to topicDiscovery, spends the pilot's only slot on a NEW video, and leaves the
 * prepared candidate untouched. That is a silent divergence, not a refusal,
 * which is why the ordinary runner is the wrong instrument here.
 *
 * Widening RESUME_FROM would fix the selection and destroy the reason the
 * exclusion exists: every future VOICEOVER_PENDING row would auto-resume
 * straight into paid narration, on any container start. So execution is
 * explicit and addressed instead — one video id, named by the caller, matched
 * against the durable authorisation, run once.
 *
 * Deliberately NOT reachable from index.ts. A container boot, a Railway
 * redeploy, or an ON_FAILURE restart runs index.ts, which only ever calls
 * runPipeline(); none of them can reach this function. Starting the canary
 * requires a human to invoke it by name and pass the candidate id.
 */
export async function runWcCanaryOnce(
  videoId: string,
  summary?: RunSummary,
): Promise<void> {
  console.log(`${LOG} ═══ One-shot canary execution — candidate ${videoId} ═══`);
  console.log(`${LOG} Channel: Wet Circuit (${WC_CHANNEL_ID})`);

  await withAdvisoryLock(prisma, WC_LOCK_ID, async () => {
    console.log(`${LOG} Advisory lock acquired (id: ${WC_LOCK_ID})`);

    // Same gate as the ordinary runner: channel, runnability, cap, window,
    // unresolved intents.
    const pilot = await pilotGate();
    if (!pilot) {
      throw new PilotBlockedError("CANARY_NO_PILOT",
        "one-shot canary execution requires an active pilot — refusing to run uncapped");
    }

    // Quarantine is checked explicitly as well as by status, so restoring a
    // row's status by hand cannot silently re-arm it.
    const quarantined = await quarantinedVideoIds();
    if (quarantined.includes(videoId)) {
      throw new PilotBlockedError("CANARY_QUARANTINED",
        `candidate ${videoId} is quarantined — refusing to run it`);
    }

    const video = await prisma.wcVideo.findUnique({
      where: { id: videoId },
      include: { topic: true },
    });
    if (!video) {
      throw new PilotBlockedError("CANARY_CANDIDATE_MISSING",
        `no wcVideo row with id ${videoId}`);
    }

    // The one-shot runner starts at narration, so the row must be exactly at
    // the point narration begins. Any other status means either the work was
    // not prepared or it has already started, and both are refusals: this
    // function must never be a way to re-narrate.
    if (video.status !== VideoStatus.VOICEOVER_PENDING) {
      throw new PilotBlockedError("CANARY_WRONG_STATUS",
        `candidate ${videoId} is ${video.status}, expected ${VideoStatus.VOICEOVER_PENDING} — refusing`);
    }

    // The row must describe the run about to happen. A candidate prepared under
    // DISABLE_ELEVEN=true still says DRY_RUN, and the halt guard only blocks on
    // `FAILED AND runMode = 'LIVE'` — so a DRY_RUN-tagged canary that failed
    // after real spend would halt nothing, and the next run would start a
    // brand-new video. ARM flips this; refuse if it did not.
    if (video.runMode !== "LIVE") {
      throw new PilotBlockedError("CANARY_RUNMODE_NOT_LIVE",
        `candidate ${videoId} is tagged runMode=${video.runMode} — a failure would not arm the halt guard`);
    }

    // Re-entry guard. If a previous attempt got past narration, assembly or
    // upload, these fields are populated and running from `voiceover` again
    // would re-spend. Recovery from a partial attempt is the ordinary resume
    // path's job, not this one's.
    const spent: string[] = [];
    if (video.voiceoverPath) spent.push("voiceoverPath");
    if (video.voiceoverUrls.length > 0) spent.push("voiceoverUrls");
    if (video.videoPath) spent.push("videoPath");
    if (video.youtubeId) spent.push("youtubeId");
    if (video.scheduledAt) spent.push("scheduledAt");
    if (video.shortsUrl) spent.push("shortsUrl");
    if (spent.length > 0) {
      throw new PilotBlockedError("CANARY_ALREADY_STARTED",
        `candidate ${videoId} already has ${spent.join(", ")} — refusing to re-run from ${CANARY_START_STAGE}`);
    }

    const script = video.scriptJson as unknown as Script | null;
    if (!script) {
      throw new PilotBlockedError("CANARY_NO_SCRIPT",
        `candidate ${videoId} has no scriptJson — nothing to narrate`);
    }

    // Full authorisation resolve, not just the window: candidate identity,
    // script hash, channel, narration ceiling, runtime envelope, and that the
    // pilot's durable policy still matches what was authorised. Fails closed.
    const resolved = resolveWcCanaryAuthorization({
      pilot,
      candidateId: videoId,
      script,
      submitChars: spokenCharacterCount(buildSpokenUnits(script)),
    });
    if (!resolved) {
      throw new PilotBlockedError("CANARY_NOT_AUTHORIZED",
        `pilot ${pilot.pilotId} has no canary authorisation — refusing one-shot execution`);
    }
    console.log(
      `${LOG} authorisation OK — profile=${resolved.qualityProfileName} ` +
      `maxConceptShare=${resolved.effectiveMaxConceptShare} ` +
      `submitChars=${resolved.submitChars} script=${resolved.scriptSha256.slice(0, 12)}`,
    );

    const stages = STAGES.filter((s) => !s.skipDuringPilot);
    const skipped = STAGES.filter((s) => s.skipDuringPilot).map((s) => s.name);
    if (skipped.length) console.log(`${LOG} pilot skips: ${skipped.join(", ")}`);

    const startIdx = stages.findIndex((s) => s.name === CANARY_START_STAGE);
    if (startIdx < 0) {
      throw new Error(`no stage named "${CANARY_START_STAGE}" — stage list drifted`);
    }
    const runFrom = stages.slice(startIdx);
    console.log(`${LOG} running ${runFrom.length} stage(s) from ${runFrom[0].name}`);

    summary?.setVideoId(video.id);
    const ctx: PipelineContext = {
      topic: video.topic,
      video,
      script,
      voiceoverUrls: video.voiceoverUrls,
      videoUrl: video.videoPath ?? undefined,
      seo:
        video.seoTitle && video.seoDescription
          ? {
              title: video.seoTitle,
              description: video.seoDescription,
              tags: video.seoTags,
              chapters: (video.seoChapters as unknown as SEOMetadata["chapters"]) ?? [],
            }
          : undefined,
    };

    const ok = await runStages(runFrom, ctx, summary);
    if (ok) {
      await cleanupTmpDir(ctx.video.id);
      await finalizeSummary(summary, ctx.video.id);
      console.log(`${LOG} ✓ Canary complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`);
    }
  });
}

// ── Entry point (only when run directly) ──────────────────────────────────

const isDirectRun =
  process.argv[1]?.endsWith("pipeline.ts") ||
  process.argv[1]?.endsWith("pipeline.js");

if (isDirectRun) {
  runPipeline()
    .then(async () => {
      await disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`${LOG} Fatal:`, err);
      await disconnect();
      process.exit(1);
    });
}
