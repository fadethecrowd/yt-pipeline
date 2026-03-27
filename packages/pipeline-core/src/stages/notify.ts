import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { env } from "../config";
import type { PipelineContext, StageResult } from "../types";

/**
 * Send a plain text message via Telegram.
 */
async function sendTextMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[notify] Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

/**
 * Send the applied thumbnail to Telegram as a single photo with caption.
 */
async function sendAppliedThumbnail(ctx: PipelineContext): Promise<void> {
  const config = env();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.log("[notify] Telegram not configured, skipping");
    return;
  }

  const thumbnailPath = ctx.thumbnailA;
  if (!thumbnailPath || !existsSync(thumbnailPath)) {
    console.log("[notify] No thumbnail file to send");
    return;
  }

  const title = ctx.seo?.title ?? ctx.topic.title;
  const youtubeUrl = ctx.youtubeId ? `https://youtu.be/${ctx.youtubeId}` : "";
  const caption = [
    `Thumbnail applied — "${title}"`,
    "",
    `Variant A (auto-selected)`,
    ...(youtubeUrl ? ["", youtubeUrl] : []),
  ].join("\n");

  const form = new FormData();
  form.append("chat_id", config.TELEGRAM_CHAT_ID);
  form.append("caption", caption);

  const buffer = await readFile(thumbnailPath);
  const blob = new Blob([buffer], { type: "image/jpeg" });
  form.append("photo", blob, "thumbnail.jpg");

  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendPhoto ${res.status}: ${body}`);
  }

  console.log(`[notify] Sent applied thumbnail to Telegram`);
}

/**
 * Stage: Notify on pipeline result via Telegram.
 * On success: sends the applied thumbnail as confirmation (no approval required).
 * On failure: sends error details as text.
 */
export async function notify(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const hasTelegram = config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID;
  const failed = !!ctx.video.failReason;

  if (failed) {
    console.log(`[notify] Pipeline failed for video ${ctx.video.id}`);
    console.log(`[notify]   Topic:  ${ctx.topic.title}`);
    console.log(`[notify]   Reason: ${ctx.video.failReason}`);

    if (hasTelegram) {
      const text = [
        `Pipeline failed for "${ctx.topic.title}"`,
        `Reason: ${ctx.video.failReason}`,
        `Video ID: ${ctx.video.id}`,
      ].join("\n");

      try {
        await sendTextMessage(config.TELEGRAM_BOT_TOKEN!, config.TELEGRAM_CHAT_ID!, text);
      } catch (err) {
        console.error("[notify] Failure notification failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }
  } else {
    console.log(`[notify] Pipeline succeeded for video ${ctx.video.id}`);
    console.log(`[notify]   Topic:   ${ctx.topic.title}`);
    if (ctx.youtubeId) {
      console.log(`[notify]   YouTube: https://youtu.be/${ctx.youtubeId}`);
    }

    if (hasTelegram) {
      try {
        await sendAppliedThumbnail(ctx);
      } catch (err) {
        console.error("[notify] Thumbnail notification failed, sending text fallback:", err instanceof Error ? err.message : err);

        const title = ctx.seo?.title ?? ctx.topic.title;
        const youtubeUrl = ctx.youtubeId ? `https://youtu.be/${ctx.youtubeId}` : "n/a";
        const text = [
          `Video uploaded: "${title}"`,
          `YouTube: ${youtubeUrl}`,
          `Thumbnail: Variant A (applied to YouTube)`,
        ].join("\n");

        try {
          await sendTextMessage(config.TELEGRAM_BOT_TOKEN!, config.TELEGRAM_CHAT_ID!, text);
        } catch (fallbackErr) {
          console.error("[notify] Text fallback also failed (non-fatal):", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
        }
      }
    }
  }

  return { success: true, durationMs: Date.now() - start };
}
