import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { currentTestStage } from "../lib/testStage";
import { runVoiceover } from "./voiceoverShared";
import type { PipelineContext, StageResult } from "../types";

/**
 * AI Doom Scroll voiceover stage.
 *
 * Delegates to the shared implementation: ElevenLabs `/with-timestamps` per
 * segment (idempotent, credit-accounted) followed by sample-exact assembly of
 * the narration track.
 */
export async function voiceover(ctx: PipelineContext): Promise<StageResult> {
  return runVoiceover(ctx, {
    channel: "ai-doom-scroll",
    label: "voiceover",
    testStage: currentTestStage(),
    updateVideo: (id, data) =>
      prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id, status) =>
      prisma.video.update({
        where: { id },
        data: { status: status as VideoStatus },
      }),
  });
}
