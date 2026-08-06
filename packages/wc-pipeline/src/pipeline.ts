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
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "@yt-pipeline/pipeline-core";

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

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runPipeline(summary?: RunSummary): Promise<void> {
  const pipelineStart = Date.now();
  console.log(`${LOG} ═══ Run started at ${ts()} ═══`);
  console.log(`${LOG} Channel: Wet Circuit (${WC_CHANNEL_ID})`);

  await withAdvisoryLock(prisma, WC_LOCK_ID, async () => {
    console.log(`${LOG} Advisory lock acquired (id: ${WC_LOCK_ID})`);

    // ── Pilot gate ────────────────────────────────────────────────────
    //
    // Every check reads the durable row, so a redeploy or a crash cannot reset
    // what the pilot has already used. The advisory lock above is the first
    // concurrency defence; the cap below fails closed independently of it,
    // because a lock that is somehow not held must not become permission to
    // exceed the limit.
    const pilot = await currentPilot();
    if (pilot) {
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
      if (!isInWindow(new Date(), {
        days: pilot.windowDays, startHour: pilot.windowStartHour,
        endHour: pilot.windowEndHour, timeZone: pilot.timezone,
      })) {
        console.log(
          `${LOG} outside the pilot execution window ` +
          `(${pilot.windowStartHour}:00-${pilot.windowEndHour}:00 ${pilot.timezone}); ` +
          `now is ${formatZoned(new Date(), pilot.timezone)}`,
        );
      }
      // An unresolved upload from a prior pilot candidate must be reconciled by
      // a human before another candidate is created: it may already be a video
      // on the channel.
      const unresolved = await prisma.uploadIntent.count({
        where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
      });
      if (unresolved > 0) {
        throw new PilotBlockedError("UNRESOLVED_INTENT",
          `${unresolved} unresolved upload intent(s) — reconcile before another pilot run`);
      }
      console.log(`${LOG} pilot slots remaining: ${left}`);
    }
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
