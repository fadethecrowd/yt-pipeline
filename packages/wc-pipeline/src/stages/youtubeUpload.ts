import { createReadStream, existsSync } from "node:fs";
import { google } from "googleapis";
import { VideoStatus } from "@prisma/client";
import { prisma, env } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult, UploadResult } from "@yt-pipeline/pipeline-core";

// ── Launch gate ─────────────────────────────────────────────────────────────

/**
 * LAUNCH_DATE controls when Wet Circuit goes public.
 * Before this date: all uploads are fully private (no publishAt).
 * On or after this date: uploads are scheduled public (Mon/Wed/Fri 2 PM EST).
 */
const LAUNCH_DATE = process.env.LAUNCH_DATE ?? "2026-03-30";

function isBeforeLaunch(): boolean {
  const launch = new Date(LAUNCH_DATE + "T00:00:00Z");
  const now = new Date();
  return now < launch;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const PUBLISH_DAYS = [1, 3, 5]; // Mon, Wed, Fri
const PUBLISH_HOUR_UTC = 19;    // 2 PM EST = 19:00 UTC

function getNextPublishSlot(): Date {
  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);

  // Same-day slot only if it is still in the future — YouTube requires
  // publishAt to be ahead of upload time; runs after 19:00 UTC on a
  // publish day fall through to the next-day search below.
  if (PUBLISH_DAYS.includes(today.getUTCDay()) && today > now) {
    return today;
  }

  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    if (PUBLISH_DAYS.includes(d.getUTCDay())) {
      return d;
    }
  }

  const fallback = new Date(today);
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  return fallback;
}

// ── Tag sanitizer (defense in depth before YouTube API call) ───────────
//
// YouTube rejects uploads with "invalid video keywords" if tags contain
// emoji, non-ASCII chars, certain punctuation, or are too numerous/long.
// SEO stage already does light cleaning; this is the strict last line of
// defense applied at the API boundary on EVERY upload (including resumes
// from DB-stored tags).

const SAFE_DEFAULT_TAGS = ["marine electronics", "fishfinder", "sonar"];

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const raw of tags ?? []) {
    if (typeof raw !== "string") continue;
    // Keep only ASCII letters, digits, spaces, hyphens. Strips emoji,
    // accented chars, punctuation, quotes, ampersands, etc.
    const stripped = raw
      .replace(/[^a-zA-Z0-9 \-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 30);
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(stripped);
    if (cleaned.length >= 20) break;
  }

  return cleaned.length > 0 ? cleaned : [...SAFE_DEFAULT_TAGS];
}

function getYouTubeClient() {
  const config = env();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth });
}

// ── Stage ────────────────────────────────────────────────────────────────

/**
 * Wet Circuit YouTube upload stage.
 *
 * Before LAUNCH_DATE: uploads as private (no scheduled publish).
 * On/after LAUNCH_DATE: uploads as private with scheduled publish (goes public automatically).
 */
export async function wcYoutubeUpload(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[wc:guard] DISABLE_ELEVEN active — skipping YouTube upload");
    const placeholderYoutubeId = `dryrun-${ctx.video.id}`;
    await prisma.wcVideo.update({
      where: { id: ctx.video.id },
      data: {
        youtubeId: placeholderYoutubeId,
        status: VideoStatus.UPLOADED,
      },
    });
    ctx.youtubeId = placeholderYoutubeId;
    return { success: true, durationMs: Date.now() - start };
  }

  const video = await prisma.wcVideo.findUnique({
    where: { id: ctx.video.id },
  });
  if (!video?.videoPath) {
    return { success: false, error: "Missing videoPath on video record", durationMs: Date.now() - start };
  }
  if (!ctx.seo) {
    return { success: false, error: "Missing SEO metadata in context", durationMs: Date.now() - start };
  }

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.UPLOAD_PENDING },
  });

  const preLaunch = isBeforeLaunch();
  const scheduledAt = preLaunch ? null : getNextPublishSlot();

  if (preLaunch) {
    console.log(`[wc:youtubeUpload] PRE-LAUNCH: uploading as private (launch date: ${LAUNCH_DATE})`);
  } else {
    console.log(`[wc:youtubeUpload] POST-LAUNCH: scheduled publish ${scheduledAt!.toISOString()}`);
  }
  console.log(`[wc:youtubeUpload] Title: ${ctx.seo.title}`);
  console.log(`[wc:youtubeUpload] Video file: ${video.videoPath}`);

  const youtube = getYouTubeClient();

  const safeTags = sanitizeTags(ctx.seo.tags);
  console.log(`[wc:youtubeUpload] Sanitized tags (${safeTags.length}): ${safeTags.join(", ")}`);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: ctx.seo.title,
        description: ctx.seo.description,
        tags: safeTags,
        categoryId: "28", // Science & Technology
        defaultLanguage: "en",
      },
      status: {
        privacyStatus: "private",
        ...(scheduledAt ? { publishAt: scheduledAt.toISOString() } : {}),
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(video.videoPath),
    },
  });

  const youtubeId = res.data.id;
  if (!youtubeId) {
    return { success: false, error: "YouTube API returned no video ID", durationMs: Date.now() - start };
  }

  console.log(`[wc:youtubeUpload] Uploaded: https://youtu.be/${youtubeId}${preLaunch ? " (PRIVATE until launch)" : ""}`);

  // Auto-set thumbnail (Variant A) immediately after upload
  // Try ctx first (set by wcThumbnailGenerator), fall back to DB record
  const thumbnailPath = ctx.thumbnailA ?? video.thumbnailA;
  if (thumbnailPath && existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId: youtubeId,
        media: { body: createReadStream(thumbnailPath) },
      });
      console.log(`[wc:youtubeUpload] Thumbnail applied: ${thumbnailPath}`);
    } catch (err) {
      console.error(`[wc:youtubeUpload] Thumbnail set failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.log("[wc:youtubeUpload] No thumbnail available to set");
  }

  const result: UploadResult = {
    youtubeId,
    scheduledAt: scheduledAt ?? new Date(),
  };

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      youtubeId: result.youtubeId,
      scheduledAt: scheduledAt,
      status: VideoStatus.UPLOADED,
    },
  });

  ctx.youtubeId = result.youtubeId;

  return { success: true, data: result, durationMs: Date.now() - start };
}
