import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, StageResult } from "../types";

/**
 * Stage 3: Use Claude API to score the script 0-100.
 * Skips the video (marks QUALITY_FAILED) if score < threshold (default 75).
 */
export async function qualityGate(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const threshold = env().QUALITY_THRESHOLD;

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  // TODO: Initialize Anthropic client
  // const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });

  // TODO: Build scoring prompt
  // const prompt = `Score the following YouTube script 0-100 on:
  //   - Hook strength (0-20)
  //   - Content accuracy (0-25)
  //   - Engagement / pacing (0-25)
  //   - CTA effectiveness (0-15)
  //   - Visual prompt quality (0-15)
  //   Return JSON: { score: number, breakdown: {...}, feedback: string }`;

  // TODO: Call Claude API and parse score
  const score = 0; // placeholder

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { qualityScore: score },
  });

  if (score < threshold) {
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: { status: VideoStatus.QUALITY_FAILED },
    });
    return {
      success: false,
      error: `Quality score ${score} below threshold ${threshold}`,
      durationMs: Date.now() - start,
    };
  }

  return { success: true, data: { score }, durationMs: Date.now() - start };
}
