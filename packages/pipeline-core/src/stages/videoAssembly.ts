import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { currentTestStage } from "../lib/testStage";
import { runAssembly } from "./assemblyShared";
import type { PipelineContext, StageResult } from "../types";

export { TITLE_CARD_DURATION, DURATION_TOLERANCE, cleanupAssemblyTmp } from "./assemblyShared";
export type { AssemblyOutcome } from "./assemblyShared";

/**
 * AI Doom Scroll video assembly.
 *
 * Delegates to the shared implementation, which builds the timeline from the
 * narration manifest (exact decoded segment offsets) and the ElevenLabs
 * character alignments, rather than from MP3 header estimates.
 */
export async function videoAssembly(ctx: PipelineContext): Promise<StageResult> {
  return runAssembly(ctx, {
    channel: "ai-doom-scroll",
    label: "assembly",
    testStage: currentTestStage(),
    getVideo: (id) => prisma.video.findUnique({ where: { id } }),
    updateVideo: (id, data) =>
      prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id, status) =>
      prisma.video.update({ where: { id }, data: { status: status as VideoStatus } }),
  });
}
