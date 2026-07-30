import { VideoStatus } from "@prisma/client";
import { prisma, runAssembly, currentTestStage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

/**
 * Wet Circuit video assembly.
 *
 * Same shared implementation as AI Doom Scroll, writing to wc_video.
 */
export async function wcVideoAssembly(ctx: PipelineContext): Promise<StageResult> {
  return runAssembly(ctx, {
    channel: "wet-circuit",
    label: "wc:assembly",
    testStage: currentTestStage(),
    getVideo: (id) => prisma.wcVideo.findUnique({ where: { id } }),
    updateVideo: (id, data) =>
      prisma.wcVideo.update({ where: { id }, data: data as never }),
    setStatus: (id, status) =>
      prisma.wcVideo.update({ where: { id }, data: { status: status as VideoStatus } }),
  });
}
