import type { PipelineContext, StageResult } from "../types";

/**
 * Stage 8: Log pipeline result to console.
 * A different notification method (email, Slack, etc.) can be wired in later.
 */
export async function notify(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const failed = !!ctx.video.failReason;

  if (failed) {
    console.log(`[notify] Pipeline failed for video ${ctx.video.id}`);
    console.log(`[notify]   Topic:  ${ctx.topic.title}`);
    console.log(`[notify]   Reason: ${ctx.video.failReason}`);
  } else {
    console.log(`[notify] Pipeline succeeded for video ${ctx.video.id}`);
    console.log(`[notify]   Topic:   ${ctx.topic.title}`);
    if (ctx.youtubeId) {
      console.log(`[notify]   YouTube: https://youtu.be/${ctx.youtubeId}`);
    }
  }

  return { success: true, durationMs: Date.now() - start };
}
