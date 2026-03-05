import { VideoStatus } from "@prisma/client";
import { prisma } from "./lib/db";
import { withAdvisoryLock } from "./lib/lock";
import { withRetry } from "./lib/retry";
import { env } from "./config";
import type { PipelineContext, StageDefinition, StageResult } from "./types";

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
  { name: "scriptGenerator", execute: scriptGenerator, retries: 2 },
  { name: "qualityGate", execute: qualityGate, retries: 1 },
  { name: "voiceover", execute: voiceover, retries: 3 },
  { name: "videoAssembly", execute: videoAssembly, retries: 3 },
  { name: "seoGenerator", execute: seoGenerator, retries: 2 },
  { name: "youtubeUpload", execute: youtubeUpload, retries: 3 },
  { name: "notify", execute: notify, retries: 2 },
];

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runPipeline(): Promise<void> {
  const config = env();

  await withAdvisoryLock(prisma, config.PIPELINE_LOCK_ID, async () => {
    console.log("[pipeline] Acquiring advisory lock — starting run");

    // Stage 0: discover new topics and pick the best one
    const discoveryResult = await withRetry(
      () => topicDiscovery({} as PipelineContext),
      { maxRetries: 2, label: "topicDiscovery" }
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

    // Run each stage sequentially
    for (const stage of STAGES) {
      console.log(`[pipeline] ▸ ${stage.name}`);
      const start = Date.now();

      let result: StageResult;
      try {
        result = await withRetry(() => stage.execute(ctx), {
          maxRetries: stage.retries,
          label: stage.name,
        });
      } catch (err) {
        const failReason =
          err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] ✗ ${stage.name} failed: ${failReason}`);

        await prisma.video.update({
          where: { id: video.id },
          data: {
            status: VideoStatus.FAILED,
            failReason: `${stage.name}: ${failReason}`,
            retryCount: { increment: 1 },
          },
        });

        // Send failure notification
        await notify({
          ...ctx,
          video: { ...ctx.video, failReason: `${stage.name}: ${failReason}` },
        }).catch(() => {}); // best-effort

        return;
      }

      if (!result.success) {
        console.error(
          `[pipeline] ✗ ${stage.name} rejected: ${result.error}`
        );
        await prisma.video.update({
          where: { id: video.id },
          data: {
            status: VideoStatus.FAILED,
            failReason: `${stage.name}: ${result.error}`,
          },
        });
        await notify({
          ...ctx,
          video: { ...ctx.video, failReason: `${stage.name}: ${result.error}` },
        }).catch(() => {});
        return;
      }

      console.log(
        `[pipeline] ✓ ${stage.name} (${Date.now() - start}ms)`
      );
    }

    console.log(
      `[pipeline] ✓ Complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
    );
  });
}

// ── Entry point ────────────────────────────────────────────────────────────

runPipeline()
  .catch((err) => {
    console.error("[pipeline] Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
