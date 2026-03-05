import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { PipelineContext, StageResult, UploadResult } from "../types";

/**
 * Stage 7: Upload video via YouTube Data API v3 with scheduled publish.
 */
export async function youtubeUpload(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.videoUrl || !ctx.seo) {
    return {
      success: false,
      error: "Missing video URL or SEO metadata",
      durationMs: Date.now() - start,
    };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.UPLOAD_PENDING },
  });

  // TODO: Authenticate with YouTube using OAuth2
  // const auth = new google.auth.OAuth2(
  //   env().YOUTUBE_CLIENT_ID,
  //   env().YOUTUBE_CLIENT_SECRET,
  // );
  // auth.setCredentials({ refresh_token: env().YOUTUBE_REFRESH_TOKEN });
  // const youtube = google.youtube({ version: "v3", auth });

  // TODO: Download video from ctx.videoUrl to temp file

  // TODO: Upload via youtube.videos.insert
  // const scheduledAt = getNextPublishSlot(); // e.g. next 9am ET
  // const res = await youtube.videos.insert({
  //   part: ["snippet", "status"],
  //   requestBody: {
  //     snippet: {
  //       title: ctx.seo.title,
  //       description: ctx.seo.description,
  //       tags: ctx.seo.tags,
  //       categoryId: "28", // Science & Technology
  //     },
  //     status: {
  //       privacyStatus: "private",
  //       publishAt: scheduledAt.toISOString(),
  //     },
  //   },
  //   media: { body: fs.createReadStream(tempPath) },
  // });

  const scheduledAt = new Date(); // placeholder
  const result: UploadResult = {
    youtubeId: "TODO",
    scheduledAt,
  };

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
