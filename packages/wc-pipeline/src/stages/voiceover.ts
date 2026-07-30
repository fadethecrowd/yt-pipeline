import { VideoStatus } from "@prisma/client";
import { prisma, runVoiceover, currentTestStage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

/**
 * Wet Circuit voiceover stage.
 *
 * Same shared implementation as AI Doom Scroll, writing to wc_video. Voice and
 * model come from this service's own env, so the two channels keep distinct
 * voices.
 */
export async function wcVoiceover(ctx: PipelineContext): Promise<StageResult> {
  return runVoiceover(ctx, {
    channel: "wet-circuit",
    label: "wc:voiceover",
    testStage: currentTestStage(),
    updateVideo: (id, data) =>
      prisma.wcVideo.update({ where: { id }, data: data as never }),
    setStatus: (id, status) =>
      prisma.wcVideo.update({
        where: { id },
        data: { status: status as VideoStatus },
      }),
  });
}
