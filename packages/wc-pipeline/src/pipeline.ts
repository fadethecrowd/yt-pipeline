import { join } from "node:path";
import { rm } from "node:fs/promises";
import { TopicStatus, VideoStatus } from "@prisma/client";
import {
  prisma,
  disconnect,
  withAdvisoryLock,
  withRetry,
  env,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "@yt-pipeline/pipeline-core";

import { topicDiscovery } from "./stages/topicDiscovery";
import { scriptGenerator } from "./stages/scriptGenerator";
import { qualityGate } from "./stages/qualityGate";
import { seoGenerator } from "./stages/seoGenerator";
import { wcThumbnailGenerator } from "./stages/thumbnailGenerator";
import { wcVoiceover } from "./stages/voiceover";
import { wcVideoAssembly } from "./stages/videoAssembly";
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
// Order: discover → script → quality gate → SEO → thumbnail → voiceover → assembly → upload → notify
// SEO + thumbnails run before voiceover because they only need the script, not audio.

const STAGES: StageDefinition[] = [
  { name: "topicDiscovery",       execute: topicDiscovery,       retries: 2 },
  { name: "scriptGenerator",      execute: scriptGenerator,      retries: 2 },
  { name: "qualityGate",          execute: qualityGate,          retries: 0 },
  { name: "seoGenerator",         execute: seoGenerator,         retries: 2 },
  { name: "wcThumbnailGenerator", execute: wcThumbnailGenerator, retries: 2 },
  { name: "voiceover",            execute: wcVoiceover,          retries: 3 },
  { name: "videoAssembly",        execute: wcVideoAssembly,      retries: 3 },
  { name: "youtubeUpload",        execute: wcYoutubeUpload,      retries: 3 },
  { name: "shortsGenerator",      execute: wcShortsGenerator,    retries: 1 },
  { name: "notify",               execute: wcNotify,             retries: 2 },
];

// Map video status → stage index to resume from.
// Only statuses that indicate a stage completed but the next one hasn't started.
const RESUME_FROM: Partial<Record<VideoStatus, number>> = {
  [VideoStatus.SEO_DONE]:       4, // SEO done → resume at wcThumbnailGenerator
  [VideoStatus.VOICEOVER_DONE]: 6, // voiceover done → resume at videoAssembly
  [VideoStatus.ASSEMBLY_DONE]:  7, // assembly done → resume at youtubeUpload
};

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
      await failVideo(ctx, stage.name, reason);
      return false;
    }

    if (!result.success) {
      console.error(`${LOG} ✗ ${stage.name} rejected: ${result.error}`);
      console.log(`${LOG} ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`);
      await failVideo(ctx, stage.name, result.error ?? "unknown error");
      return false;
    }

    console.log(`${LOG} ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`);
  }

  return true;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
  const pipelineStart = Date.now();
  console.log(`${LOG} ═══ Run started at ${ts()} ═══`);
  console.log(`${LOG} Channel: Wet Circuit (${WC_CHANNEL_ID})`);

  await withAdvisoryLock(prisma, WC_LOCK_ID, async () => {
    console.log(`${LOG} Advisory lock acquired (id: ${WC_LOCK_ID})`);

    // ── Check for stuck videos that can be resumed ────────────────────

    const resumableStatuses = Object.keys(RESUME_FROM) as VideoStatus[];
    const stuckVideo = await prisma.wcVideo.findFirst({
      where: { status: { in: resumableStatuses } },
      include: { topic: true },
      orderBy: { updatedAt: "asc" }, // oldest stuck video first
    });

    if (stuckVideo) {
      const resumeIdx = RESUME_FROM[stuckVideo.status]!;
      const resumeStages = STAGES.slice(resumeIdx);
      console.log(
        `${LOG} Resuming video ${stuckVideo.id} (stuck at ${stuckVideo.status}) from ${resumeStages[0].name}`,
      );

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

      const ok = await runStages(resumeStages, ctx);
      if (ok) {
        await cleanupTmpDir(ctx.video.id);
        console.log(`${LOG} ✓ Resumed complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`);
      }
      return;
    }

    // ── Stage 1: Topic Discovery (seeds the context) ──────────────────

    const discoveryStage = STAGES[0];
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
        return;
      }

      console.log(`${LOG} Using fallback APPROVED topic: "${fallbackTopic.title}"`);
      discoveryResult = { success: true, data: fallbackTopic, durationMs: discoveryResult.durationMs };
    }

    const topic = discoveryResult.data as PipelineContext["topic"];

    // Create a video record to track through the pipeline
    const video = await prisma.wcVideo.create({
      data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING },
    });

    const ctx: PipelineContext = { topic, video };
    console.log(`${LOG} Video ${video.id} created for topic "${topic.title}"`);

    // ── Stages 2–8 (scriptGenerator → notify) ─────────────────────────

    const ok = await runStages(STAGES.slice(1), ctx);
    if (ok) {
      await cleanupTmpDir(ctx.video.id);
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
