import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, StageResult, UploadResult } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the publish slot for the current pipeline run.
 *
 * Always publishes same-day: if today is Mon/Wed/Fri, use today at
 * 2 PM EST (19:00 UTC). Multiple videos per day is allowed — AI news
 * gets stale fast so same-day publish is the priority.
 *
 * If today is not a publish day (Tue/Thu/Sat/Sun), use the next
 * Mon/Wed/Fri at 2 PM EST.
 */
function getNextPublishSlot(): Date {
  const PUBLISH_DAYS = [1, 3, 5]; // Mon, Wed, Fri
  const PUBLISH_HOUR_UTC = 19; // 2 PM EST = 19:00 UTC

  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);

  if (PUBLISH_DAYS.includes(today.getUTCDay())) {
    console.log(`[youtubeUpload] Using same-day slot: ${today.toISOString()}`);
    return today;
  }

  // Find the next Mon/Wed/Fri
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    if (PUBLISH_DAYS.includes(d.getUTCDay())) {
      console.log(`[youtubeUpload] Next publish day: ${d.toISOString()}`);
      return d;
    }
  }

  // Should never reach here, but fallback to tomorrow
  const fallback = new Date(today);
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  return fallback;
}

/**
 * Create an authenticated YouTube Data API v3 client.
 */
function getYouTubeClient() {
  const config = env();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth });
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Stage: Upload video via YouTube Data API v3 with scheduled publish.
 */
export async function youtubeUpload(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  // Re-read video from DB to get videoPath and SEO fields
  const video = await prisma.video.findUnique({
    where: { id: ctx.video.id },
  });
  if (!video?.videoPath) {
    return {
      success: false,
      error: "Missing videoPath on video record",
      durationMs: Date.now() - start,
    };
  }
  if (!ctx.seo) {
    return {
      success: false,
      error: "Missing SEO metadata in context",
      durationMs: Date.now() - start,
    };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.UPLOAD_PENDING },
  });

  const scheduledAt = getNextPublishSlot();
  console.log(`[youtubeUpload] Scheduled publish: ${scheduledAt.toISOString()}`);
  console.log(`[youtubeUpload] Title: ${ctx.seo.title}`);
  console.log(`[youtubeUpload] Video file: ${video.videoPath}`);

  const youtube = getYouTubeClient();

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: ctx.seo.title,
        description: ctx.seo.description,
        tags: ctx.seo.tags,
        categoryId: "28", // Science & Technology
        defaultLanguage: "en",
      },
      status: {
        privacyStatus: "private",
        publishAt: scheduledAt.toISOString(),
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(video.videoPath),
    },
  });

  const youtubeId = res.data.id;
  if (!youtubeId) {
    return {
      success: false,
      error: "YouTube API returned no video ID",
      durationMs: Date.now() - start,
    };
  }

  console.log(`[youtubeUpload] Uploaded: https://youtu.be/${youtubeId}`);

  const result: UploadResult = { youtubeId, scheduledAt };

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      youtubeId: result.youtubeId,
      scheduledAt: result.scheduledAt,
      status: VideoStatus.UPLOADED,
    },
  });

  ctx.youtubeId = result.youtubeId;

  return { success: true, data: result, durationMs: Date.now() - start };
}
