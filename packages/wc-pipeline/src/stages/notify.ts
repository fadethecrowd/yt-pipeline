import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { prisma, env } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

/**
 * Send a plain text message via Telegram.
 */
async function sendText(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[wc:notify] Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

/**
 * Send thumbnail variants as a Telegram media group.
 */
async function sendThumbnailGroup(
  token: string,
  chatId: string,
  paths: string[],
  caption: string,
): Promise<void> {
  const labels = ["A", "B", "C"];
  const media = paths.map((_, i) => ({
    type: "photo" as const,
    media: `attach://photo${i}`,
    ...(i === 0 ? { caption } : {}),
  }));

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("media", JSON.stringify(media));

  for (let i = 0; i < paths.length; i++) {
    const buffer = await readFile(paths[i]);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    form.append(`photo${i}`, blob, `thumbnail_${labels[i]}.jpg`);
  }

  const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
  const res = await fetch(url, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendMediaGroup ${res.status}: ${body}`);
  }
}

/**
 * Wet Circuit notify stage.
 *
 * On success: sends video details + all 3 thumbnail variants to Telegram.
 * On failure: sends error details as text.
 */
export async function wcNotify(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  const hasTelegram = !!(token && chatId);

  // Re-read from DB for latest fields (shortsUrl, thumbnails, etc.)
  const video = await prisma.wcVideo.findUnique({
    where: { id: ctx.video.id },
    include: { topic: true },
  });

  const failed = !!(video?.failReason || ctx.video.failReason);

  if (failed) {
    const reason = video?.failReason ?? ctx.video.failReason ?? "unknown";
    console.log(`[wc:notify] Pipeline failed for video ${ctx.video.id}`);
    console.log(`[wc:notify]   Topic:  ${ctx.topic.title}`);
    console.log(`[wc:notify]   Reason: ${reason}`);

    if (hasTelegram) {
      try {
        await sendText(token!, chatId!, [
          `[Wet Circuit] Pipeline failed`,
          `Topic: "${ctx.topic.title}"`,
          `Reason: ${reason}`,
          `Video ID: ${ctx.video.id}`,
        ].join("\n"));
      } catch (err) {
        console.error("[wc:notify] Failure notification failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }
  } else {
    const title = video?.seoTitle ?? ctx.seo?.title ?? ctx.topic.title;
    const youtubeUrl = ctx.youtubeId ? `https://youtu.be/${ctx.youtubeId}` : "";
    const shortsUrl = video?.shortsUrl ?? "";

    console.log(`[wc:notify] Pipeline succeeded for video ${ctx.video.id}`);
    console.log(`[wc:notify]   Title:   ${title}`);
    if (youtubeUrl) console.log(`[wc:notify]   YouTube: ${youtubeUrl}`);
    if (shortsUrl) console.log(`[wc:notify]   Short:   ${shortsUrl}`);

    if (hasTelegram) {
      // Collect thumbnail paths from ctx or DB
      const thumbPaths = [
        ctx.thumbnailA ?? video?.thumbnailA,
        ctx.thumbnailB ?? video?.thumbnailB,
        ctx.thumbnailC ?? video?.thumbnailC,
      ].filter((p): p is string => !!p && existsSync(p));

      const caption = [
        `[Wet Circuit] Video uploaded — "${title}"`,
        "",
        `Variant A applied to YouTube`,
        ...(youtubeUrl ? ["", youtubeUrl] : []),
        ...(shortsUrl ? [`Short: ${shortsUrl}`] : []),
      ].join("\n");

      if (thumbPaths.length > 0) {
        try {
          await sendThumbnailGroup(token!, chatId!, thumbPaths, caption);
          console.log(`[wc:notify] Sent ${thumbPaths.length} thumbnails to Telegram`);
        } catch (err) {
          console.error("[wc:notify] Media group failed, sending text fallback:", err instanceof Error ? err.message : err);
          try {
            await sendText(token!, chatId!, caption);
          } catch {
            // Non-fatal
          }
        }
      } else {
        try {
          await sendText(token!, chatId!, caption);
        } catch (err) {
          console.error("[wc:notify] Text notification failed (non-fatal):", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  return { success: true, durationMs: Date.now() - start };
}
