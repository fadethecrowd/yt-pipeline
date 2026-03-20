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
 * If today is Mon/Wed/Fri, always use today at 2 PM EST (19:00 UTC)
 * regardless of what time the pipeline ran. Only jump to the next
 * Mon/Wed/Fri slot if today is not a valid publish day.
 */
async function getNextPublishSlot(): Promise<Date> {
  const PUBLISH_DAYS = [1, 3, 5]; // Mon, Wed, Fri
  const PUBLISH_HOUR_UTC = 19; // 2 PM EST = 19:00 UTC
  const MAX_WEEKS_AHEAD = 8;

  const now = new Date();

  // ── Use today's slot if today is a publish day ──────────────────
  const today = new Date(now);
  today.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);

  const todayIsPublishDay = PUBLISH_DAYS.includes(today.getUTCDay());

  if (todayIsPublishDay) {
    // Check the slot isn't already taken
    const conflict = await prisma.video.findFirst({
      where: {
        scheduledAt: today,
        status: { not: VideoStatus.FAILED },
      },
    });
    if (!conflict) {
      console.log(`[youtubeUpload] Using same-day slot: ${today.toISOString()}`);
      return today;
    }
    console.log(`[youtubeUpload] Same-day slot occupied, scanning ahead`);
  } else {
    console.log(`[youtubeUpload] Today is not a publish day (${now.toUTCString()}), scanning ahead`);
  }

  // ── Fall back to next available Mon/Wed/Fri ───────────────────────
  const slots: Date[] = [];
  for (let i = 1; i <= 7 * MAX_WEEKS_AHEAD; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    if (PUBLISH_DAYS.includes(d.getUTCDay())) {
      slots.push(d);
    }
  }

  const occupied = new Set(
    (
      await prisma.video.findMany({
        where: {
          scheduledAt: { in: slots },
          status: { not: VideoStatus.FAILED },
        },
        select: { scheduledAt: true },
      })
    )
      .filter((v) => v.scheduledAt !== null)
      .map((v) => v.scheduledAt!.getTime()),
  );

  const available = slots.find((s) => !occupied.has(s.getTime()));
  if (available) return available;

  // Fallback: slot after the last candidate
  const last = slots[slots.length - 1];
  const fallback = new Date(last);
  fallback.setUTCDate(fallback.getUTCDate() + 2);
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
 * Stage 7: Upload video via YouTube Data API v3 with scheduled publish.
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

  const scheduledAt = await getNextPublishSlot();
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
