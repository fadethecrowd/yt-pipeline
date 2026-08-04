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
  voiceover,
  videoAssembly,
  thumbnailGenerator,
  youtubeUpload,
  notify,
  RunSummary,
  currentPilot, assertRunnable, remainingSlots, PilotBlockedError,
  formatZoned, isInWindow,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "@yt-pipeline/pipeline-core";

import { topicDiscovery } from "./stages/topicDiscovery";
import { scriptGenerator } from "./stages/scriptGenerator";
import { qualityGate } from "./stages/qualityGate";
import { seoGenerator } from "./stages/seoGenerator";
import { shortsGenerator } from "./stages/shortsGenerator";
import { visualFeasibilityGate } from "./stages/visualFeasibilityGate";
import { thumbnailHeadlineGenerator } from "./stages/thumbnailHeadlineGenerator";

// ── Stage definitions (sequential) ────────────────────────────────────────

const STAGES: StageDefinition[] = [
  { name: "topicDiscovery", execute: topicDiscovery, retries: 2 },
  { name: "scriptGenerator", execute: scriptGenerator, retries: 2 },
  { name: "qualityGate", execute: qualityGate, retries: 0 },
  // Before ANY ElevenLabs budget opens. A retry here would re-query the stock
  // library for the same verdict, so it gets none.
  { name: "visualFeasibilityGate", execute: visualFeasibilityGate, retries: 0 },
  { name: "voiceover", execute: voiceover, retries: 3 },
  { name: "videoAssembly", execute: videoAssembly, retries: 3 },
  { name: "thumbnailHeadlineGenerator", execute: thumbnailHeadlineGenerator, retries: 2 },
  { name: "thumbnailGenerator", execute: thumbnailGenerator, retries: 2 },
  { name: "seoGenerator", execute: seoGenerator, retries: 2 },
  { name: "youtubeUpload", execute: youtubeUpload, retries: 3 },
  // Skipped during a pilot: a Short is a second video, a second narration and a
  // second upload, none of which the pilot authorises. Gated by the durable
  // pilot config rather than by commenting the stage out, so ordinary
  // production keeps it.
  { name: "shortsGenerator", execute: shortsGenerator, retries: 1, skipDuringPilot: true },
  { name: "notify", execute: notify, retries: 2 },
];

/**
 * Where a stuck video resumes, BY STAGE NAME.
 *
 * This used to be numeric indices into STAGES, with a comment tracking how far
 * they had shifted the last time a stage was inserted. Adding
 * visualFeasibilityGate would have shifted every one of them again, silently
 * resuming a narrated video at the wrong stage. Names cannot drift.
 */
const RESUME_FROM: Partial<Record<VideoStatus, string>> = {
  [VideoStatus.VOICEOVER_DONE]: "videoAssembly",
  [VideoStatus.ASSEMBLY_DONE]: "thumbnailHeadlineGenerator",
  [VideoStatus.SEO_DONE]: "youtubeUpload",
};

/** Fails closed rather than resuming at an arbitrary stage. */
function resumeIndex(stages: StageDefinition[], status: VideoStatus): number {
  const name = RESUME_FROM[status];
  const idx = name ? stages.findIndex((s) => s.name === name) : -1;
  if (idx < 0) throw new Error(`no resume stage named "${name}" for status ${status}`);
  return idx;
}

// ── Helpers ───────────────────────────────────────────────────────────────

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
  reason: string
) {
  const failReason = `${stageName}: ${reason}`;
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      status: VideoStatus.FAILED,
      failReason,
      retryCount: { increment: 1 },
    },
  });
  ctx.video = { ...ctx.video, failReason };

  // Best-effort failure notification
  await notify(ctx).catch(() => {});
}

async function cleanupTmpDir(videoId: string): Promise<void> {
  const tmpDir = join(process.cwd(), "tmp", videoId);
  try {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`[pipeline] Cleaned up ${tmpDir}`);
  } catch {
    // non-fatal
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Populate summary outputs from the final state of a Video DB row + run
 * the runMode-aware output verification. Called at the successful end of
 * either the resume path or the fresh-pipeline path.
 */
async function finalizeSummary(
  summary: RunSummary | undefined,
  videoDbId: string,
): Promise<void> {
  if (!summary) return;
  const v = await prisma.video.findUnique({ where: { id: videoDbId } });
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
    assemblyCompleted: true, // reaching this function means stages all succeeded
  });
}

export async function runPipeline(summary?: RunSummary): Promise<void> {
  const config = env();
  const pipelineStart = Date.now();

  console.log(`[pipeline] ═══ Run started at ${ts()} ═══`);

  await withAdvisoryLock(prisma, config.PIPELINE_LOCK_ID, async () => {
    console.log("[pipeline] Advisory lock acquired");

    // ── Pilot gate ────────────────────────────────────────────────────
    //
    // Every check reads the durable row, so a redeploy or a crash cannot
    // reset what the pilot has already used. The advisory lock above is the
    // first concurrency defence; the cap below fails closed independently of
    // it, because a lock that is somehow not held must not become permission
    // to exceed the limit.
    const pilot = await currentPilot();
    if (pilot) {
      console.log(
        `[pipeline] PILOT ${pilot.pilotId}: status=${pilot.status} ` +
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
          `[pipeline] outside the pilot execution window ` +
          `(${pilot.windowStartHour}:00-${pilot.windowEndHour}:00 ${pilot.timezone}); ` +
          `now is ${formatZoned(new Date(), pilot.timezone)}`,
        );
      }
      // An unresolved upload from a prior pilot candidate must be reconciled
      // by a human before another candidate is created: it may already be a
      // video on the channel.
      const unresolved = await prisma.uploadIntent.count({
        where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
      });
      if (unresolved > 0) {
        throw new PilotBlockedError("UNRESOLVED_INTENT",
          `${unresolved} unresolved upload intent(s) — reconcile before another pilot run`);
      }
      console.log(`[pipeline] pilot slots remaining: ${left}`);
    }
    const stages = STAGES.filter((s) => !(pilot && s.skipDuringPilot));
    if (pilot) {
      const skipped = STAGES.filter((s) => s.skipDuringPilot).map((s) => s.name);
      if (skipped.length) console.log(`[pipeline] pilot skips: ${skipped.join(", ")}`);
    }

    // ── Check for stuck videos that can be resumed ────────────────────

    const resumableStatuses = Object.keys(RESUME_FROM) as VideoStatus[];
    // Quarantined jobs are excluded explicitly as well as by status, so
    // restoring a row's status by hand cannot silently re-arm it.
    const quarantined = await quarantinedVideoIds();
    if (quarantined.length > 0) {
      console.log(`[pipeline] ${quarantined.length} quarantined job(s) excluded from resume`);
    }
    const stuckVideo = await prisma.video.findFirst({
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
        `[pipeline] Resuming video ${stuckVideo.id} (stuck at ${stuckVideo.status}) from ${resumeStages[0].name}`
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

      for (const stage of resumeStages) {
        const stageStart = Date.now();
        console.log(`[pipeline] ▸ ${stage.name} started at ${ts()}`);

        let result: StageResult;
        try {
          result = await withRetry(() => stage.execute(ctx), {
            maxRetries: stage.retries,
            label: stage.name,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[pipeline] ✗ ${stage.name} threw: ${reason}`);
          console.log(
            `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
          );
          summary?.markFailed(stage.name, err);
          await failVideo(ctx, stage.name, reason);
          return;
        }

        if (!result.success) {
          console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
          console.log(
            `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
          );
          summary?.markFailed(stage.name, new Error(result.error ?? "unknown error"));
          await failVideo(ctx, stage.name, result.error ?? "unknown error");
          return;
        }

        console.log(
          `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
      }

      await cleanupTmpDir(ctx.video.id);
      await finalizeSummary(summary, ctx.video.id);
      console.log(
        `[pipeline] ✓ Resumed complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
      );
      return;
    }

    // ── Stage 1: Topic Discovery (seeds the context) ──────────────────

    const discoveryStage = stages[0];
    const discoveryStart = Date.now();
    console.log(`[pipeline] ▸ ${discoveryStage.name} started at ${ts()}`);

    let discoveryResult: StageResult;
    try {
      discoveryResult = await withRetry(
        () => topicDiscovery({} as PipelineContext),
        { maxRetries: discoveryStage.retries, label: discoveryStage.name }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] ✗ topicDiscovery failed: ${msg}`);
      console.log(
        `[pipeline] ▸ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`
      );
      summary?.markFailed("topicDiscovery", err);
      return;
    }

    console.log(
      `[pipeline] ✓ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`
    );

    if (!discoveryResult.success || !discoveryResult.data) {
      console.log("[pipeline] Discovery found no new topics, checking for existing APPROVED topics…");

      const fallbackTopic = await prisma.topic.findFirst({
        where: {
          status: TopicStatus.APPROVED,
          videos: { none: {} },
        },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      });

      if (!fallbackTopic) {
        console.log("[pipeline] No APPROVED fallback topics either, exiting");
        summary?.markIdle();
        return;
      }

      console.log(`[pipeline] Using fallback APPROVED topic: "${fallbackTopic.title}"`);
      discoveryResult = { success: true, data: fallbackTopic, durationMs: discoveryResult.durationMs };
    }

    const topic = discoveryResult.data as PipelineContext["topic"];

    // Create a video record to track through the pipeline
    const video = await prisma.video.create({
      data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING },
    });

    const ctx: PipelineContext = { topic, video };
    summary?.setVideoId(video.id);
    console.log(`[pipeline] Video ${video.id} created for topic "${topic.title}"`);

    // ── Stages 2–8 ───────────────────────────────────────────────────

    for (const stage of stages.slice(1)) {
      const stageStart = Date.now();
      console.log(`[pipeline] ▸ ${stage.name} started at ${ts()}`);

      let result: StageResult;
      try {
        result = await withRetry(() => stage.execute(ctx), {
          maxRetries: stage.retries,
          label: stage.name,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] ✗ ${stage.name} threw: ${reason}`);
        console.log(
          `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
        summary?.markFailed(stage.name, err);
        await failVideo(ctx, stage.name, reason);
        return;
      }

      if (!result.success) {
        console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
        console.log(
          `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
        summary?.markFailed(stage.name, new Error(result.error ?? "unknown error"));
        await failVideo(ctx, stage.name, result.error ?? "unknown error");
        return;
      }

      console.log(
        `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
      );
    }

    await cleanupTmpDir(ctx.video.id);
    await finalizeSummary(summary, ctx.video.id);
    console.log(
      `[pipeline] ✓ Complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
    );
  });

  console.log(
    `[pipeline] ═══ Run finished at ${ts()} — total ${fmtDuration(Date.now() - pipelineStart)} ═══`
  );
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
      console.error("[pipeline] Fatal:", err);
      await disconnect();
      process.exit(1);
    });
}
