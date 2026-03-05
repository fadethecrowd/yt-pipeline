import type { NotifyPayload, PipelineContext, StageResult } from "../types";
import { env } from "../config";

/**
 * Stage 8: Send Slack webhook on success or failure with reason.
 */
export async function notify(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  const payload: NotifyPayload = {
    videoId: ctx.video.id,
    topicTitle: ctx.topic.title,
    success: !ctx.video.failReason,
    youtubeId: ctx.youtubeId,
    failReason: ctx.video.failReason ?? undefined,
  };

  const slackMessage = payload.success
    ? {
        text: [
          `:white_check_mark: *Video published*`,
          `*Topic:* ${payload.topicTitle}`,
          `*YouTube:* https://youtube.com/watch?v=${payload.youtubeId}`,
          `*Video ID:* ${payload.videoId}`,
        ].join("\n"),
      }
    : {
        text: [
          `:x: *Pipeline failed*`,
          `*Topic:* ${payload.topicTitle}`,
          `*Reason:* ${payload.failReason}`,
          `*Video ID:* ${payload.videoId}`,
        ].join("\n"),
      };

  // TODO: Send Slack webhook
  // await fetch(env().SLACK_WEBHOOK_URL, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(slackMessage),
  // });

  console.log("[notify] Slack payload:", JSON.stringify(slackMessage, null, 2));

  return { success: true, data: payload, durationMs: Date.now() - start };
}
