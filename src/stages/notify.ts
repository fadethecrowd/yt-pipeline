import { createReadStream, existsSync } from "node:fs";
import FormData from "form-data";
import { env } from "../config";
import type { PipelineContext, StageResult } from "../types";

/**
 * Send a Telegram media group with 3 thumbnail variants.
 */
async function sendThumbnailGroup(ctx: PipelineContext): Promise<void> {
  const config = env();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.log("[notify] Telegram not configured, skipping thumbnail delivery");
    return;
  }

  const paths = [ctx.thumbnailA, ctx.thumbnailB, ctx.thumbnailC].filter(
    (p): p is string => !!p && existsSync(p),
  );

  if (paths.length === 0) {
    console.log("[notify] No thumbnail files found, skipping media group");
    return;
  }

  const title = ctx.seo?.title ?? ctx.topic.title;
  const caption = [
    `Thumbnail variants ready — "${title}"`,
    "",
    "Upload winner to YouTube Studio > Edit > Test & Compare",
    "",
    "A = Terminal (text only)",
    "B = Frame + bottom strip",
    "C = Frame + big text overlay",
    "",
    "~2 min to set up. YouTube picks winner in 48-72hrs.",
  ].join("\n");

  const labels = ["A", "B", "C"];
  const media = paths.map((_, i) => ({
    type: "photo" as const,
    media: `attach://photo${i}`,
    ...(i === 0 ? { caption } : {}),
  }));

  const form = new FormData();
  form.append("chat_id", config.TELEGRAM_CHAT_ID);
  form.append("media", JSON.stringify(media));
  for (let i = 0; i < paths.length; i++) {
    form.append(`photo${i}`, createReadStream(paths[i]));
  }

  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMediaGroup`;
  const res = await fetch(url, {
    method: "POST",
    body: form as any,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[notify] Telegram media group failed: ${res.status} ${body}`);
  } else {
    console.log(`[notify] Sent ${paths.length} thumbnail variants to Telegram`);
  }
}

/**
 * Stage 9: Notify on pipeline result + deliver thumbnails to Telegram.
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

    // Send thumbnail variants to Telegram
    try {
      await sendThumbnailGroup(ctx);
    } catch (err) {
      console.error("[notify] Thumbnail delivery failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  return { success: true, durationMs: Date.now() - start };
}
