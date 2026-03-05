import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { AssemblyResult, PipelineContext, StageResult } from "../types";

/**
 * Stage 5: Use InVideo AI API to assemble final video.
 * Submits voiceover clips + visual prompts, polls for completion.
 */
export async function videoAssembly(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.voiceoverUrls?.length || !ctx.script) {
    return {
      success: false,
      error: "Missing voiceover URLs or script",
      durationMs: Date.now() - start,
    };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.ASSEMBLY_PENDING },
  });

  // TODO: Submit assembly job to InVideo AI API
  // const payload = {
  //   segments: ctx.script.segments.map((seg, i) => ({
  //     audio_url: ctx.voiceoverUrls![i],
  //     visual_prompt: seg.visualPrompt,
  //     duration: seg.durationEstimate,
  //   })),
  // };
  //
  // const job = await fetch("https://api.invideo.io/v1/videos", {
  //   method: "POST",
  //   headers: { Authorization: `Bearer ${env().INVIDEO_API_KEY}` },
  //   body: JSON.stringify(payload),
  // });

  // TODO: Poll for job completion with backoff

  const result: AssemblyResult = {
    jobId: "TODO",
    videoUrl: "TODO",
  };

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      assemblyJobId: result.jobId,
      videoUrl: result.videoUrl,
      status: VideoStatus.ASSEMBLY_DONE,
    },
  });

  ctx.videoUrl = result.videoUrl;

  return { success: true, data: result, durationMs: Date.now() - start };
}
