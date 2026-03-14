import { VideoStatus } from "@prisma/client";
import { prisma } from "./lib/db";
import { withAdvisoryLock } from "./lib/lock";
import { withRetry } from "./lib/retry";
import { env } from "./config";
import type { PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "./types";

import { topicDiscovery } from "./stages/topicDiscovery";
import { scriptGenerator } from "./stages/scriptGenerator";
import { qualityGate } from "./stages/qualityGate";
import { voiceover } from "./stages/voiceover";
import { videoAssembly } from "./stages/videoAssembly";
import { seoGenerator } from "./stages/seoGenerator";
import { youtubeUpload } from "./stages/youtubeUpload";
import { notify } from "./stages/notify";

// ── Stage definitions (sequential) ────────────────────────────────────────

const STAGES: StageDefinition[] = [
  { name: "topicDiscovery", execute: topicDiscovery, retries: 2 },
  { name: "scriptGenerator", execute: scriptGenerator, retries: 2 },
  { name: "qualityGate", execute: qualityGate, retries: 1 },
  { name: "voiceover", execute: voiceover, retries: 3 },
  { name: "videoAssembly", execute: videoAssembly, retries: 3 },
  { name: "seoGenerator", execute: seoGenerator, retries: 2 },
  { name: "youtubeUpload", execute: youtubeUpload, retries: 3 },
  { name: "notify", execute: notify, retries: 2 },
];

// Map video status → index into STAGES where we should resume
const RESUME_FROM: Partial<Record<VideoStatus, number>> = {
  [VideoStatus.SEO_DONE]: 6,     // resume at youtubeUpload
};

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

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
  const config = env();
  const pipelineStart = Date.now();

  console.log(`[pipeline] ═══ Run started at ${ts()} ═══`);

  await withAdvisoryLock(prisma, config.PIPELINE_LOCK_ID, async () => {
    console.log("[pipeline] Advisory lock acquired");

    // ── Check for stuck videos that can be resumed ────────────────────

    const resumableStatuses = Object.keys(RESUME_FROM) as VideoStatus[];
    const stuckVideo = await prisma.video.findFirst({
      where: { status: { in: resumableStatuses } },
      include: { topic: true },
      orderBy: { updatedAt: "asc" }, // oldest stuck video first
    });

    if (stuckVideo) {
      const resumeIdx = RESUME_FROM[stuckVideo.status]!;
      const resumeStages = STAGES.slice(resumeIdx);
      console.log(
        `[pipeline] Resuming video ${stuckVideo.id} (stuck at ${stuckVideo.status}) from ${resumeStages[0].name}`
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
          await failVideo(ctx, stage.name, reason);
          return;
        }

        if (!result.success) {
          console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
          console.log(
            `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
          );
          await failVideo(ctx, stage.name, result.error ?? "unknown error");
          return;
        }

        console.log(
          `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
      }

      console.log(
        `[pipeline] ✓ Resumed complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
      );
      return;
    }

    // ── Stage 1: Topic Discovery (seeds the context) ──────────────────

    const discoveryStage = STAGES[0];
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
      return;
    }

    console.log(
      `[pipeline] ✓ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`
    );

    if (!discoveryResult.success || !discoveryResult.data) {
      console.log("[pipeline] No viable topics found, exiting");
      return;
    }

    const topic = discoveryResult.data as PipelineContext["topic"];

    // Create a video record to track through the pipeline
    const video = await prisma.video.create({
      data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING },
    });

    const ctx: PipelineContext = { topic, video };
    console.log(`[pipeline] Video ${video.id} created for topic "${topic.title}"`);

    // ── Stages 2–8 ───────────────────────────────────────────────────

    for (const stage of STAGES.slice(1)) {
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
        await failVideo(ctx, stage.name, reason);
        return;
      }

      if (!result.success) {
        console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
        console.log(
          `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
        await failVideo(ctx, stage.name, result.error ?? "unknown error");
        return;
      }

      console.log(
        `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
      );
    }

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
    .catch((err) => {
      console.error("[pipeline] Fatal:", err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
