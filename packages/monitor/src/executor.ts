import { ActionStatus, REQUIRES_APPROVAL } from "./lib/types";
import { videos, actions } from "./lib/channelDb";
import { youtube } from "./lib/youtube";
import type { Decision } from "./lib/types";
import { routeAction } from "./actionRouter";
import { sendApprovalRequest } from "./telegram";

// NOTE: there is intentionally no heartComment() here — the YouTube Data
// API v3 has no endpoint that hearts a comment. HEART_COMMENT is handled
// in actionRouter as a Telegram Studio suggestion.

/**
 * Update a video's title via the YouTube API.
 */
export async function updateVideoTitle(
  videoId: string,
  newTitle: string,
): Promise<void> {
  const video = await videos.findUniqueOrThrow({
    where: { id: videoId },
  });

  const yt = youtube();
  await yt.videos.update({
    part: ["snippet"],
    requestBody: {
      id: video.youtubeId!,
      snippet: {
        title: newTitle,
        categoryId: "28",
      },
    },
  });
  console.log(`[executor] Updated title for ${video.youtubeId}: "${newTitle}"`);
}

/**
 * Update a video's tags via the YouTube API.
 */
export async function updateVideoTags(
  videoId: string,
  tags: string[],
): Promise<void> {
  const video = await videos.findUniqueOrThrow({
    where: { id: videoId },
  });

  const yt = youtube();

  // Fetch current snippet so we preserve title/description/categoryId
  const current = await yt.videos.list({
    part: ["snippet"],
    id: [video.youtubeId!],
  });

  const snippet = current.data.items?.[0]?.snippet;
  if (!snippet) {
    throw new Error(`Could not fetch snippet for video ${video.youtubeId}`);
  }

  await yt.videos.update({
    part: ["snippet"],
    requestBody: {
      id: video.youtubeId!,
      snippet: {
        title: snippet.title!,
        categoryId: snippet.categoryId!,
        tags,
      },
    },
  });
  console.log(`[executor] Updated tags for ${video.youtubeId}: [${tags.join(", ")}]`);
}

/**
 * Update a video's description via the YouTube API.
 */
export async function updateVideoDescription(
  videoId: string,
  newDescription: string,
): Promise<void> {
  const video = await videos.findUniqueOrThrow({ where: { id: videoId } });
  const yt = youtube();

  const current = await yt.videos.list({
    part: ["snippet"],
    id: [video.youtubeId!],
  });
  const snippet = current.data.items?.[0]?.snippet;
  if (!snippet) throw new Error(`Could not fetch snippet for video ${video.youtubeId}`);

  await yt.videos.update({
    part: ["snippet"],
    requestBody: {
      id: video.youtubeId!,
      snippet: {
        title: snippet.title!,
        categoryId: snippet.categoryId!,
        description: newDescription,
      },
    },
  });
  console.log(`[executor] Updated description for ${video.youtubeId}`);
}

/**
 * Reply to a comment via the YouTube API.
 */
export async function replyToComment(
  parentCommentId: string,
  replyText: string,
): Promise<void> {
  const yt = youtube();
  await yt.comments.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        parentId: parentCommentId,
        textOriginal: replyText,
      },
    },
  });
  console.log(`[executor] Replied to comment ${parentCommentId}`);
}

/**
 * Regenerate thumbnails and upload the best one to YouTube.
 */
export async function regenerateThumbnail(videoId: string): Promise<{
  variantBuffers: { a: Buffer; b: Buffer; c: Buffer };
  uploadedVariant: string;
}> {
  const { generateThumbnailVariants } = await import("./thumbnailGen");
  const video = await videos.findUniqueOrThrow({
    where: { id: videoId },
    include: { topic: true },
  });

  if (!video.youtubeId) throw new Error("Video has no youtubeId");

  // Download current thumbnail from YouTube
  const thumbUrl = `https://img.youtube.com/vi/${video.youtubeId}/maxresdefault.jpg`;
  const res = await fetch(thumbUrl);
  if (!res.ok) throw new Error(`Failed to download thumbnail: ${res.status}`);
  const frameBuffer = Buffer.from(await res.arrayBuffer());

  const headline = video.seoTitle ?? video.topic.title;
  const subtitle = video.topic.summary ?? video.topic.title;

  const variants = await generateThumbnailVariants(frameBuffer, headline, subtitle);

  // Upload variant B (frame + strip — most visually distinct) to YouTube
  const yt = youtube();
  const { Readable } = await import("node:stream");
  await yt.thumbnails.set({
    videoId: video.youtubeId,
    media: {
      mimeType: "image/jpeg",
      body: Readable.from(variants.b),
    },
  });
  console.log(`[executor] Uploaded new thumbnail (variant B) for ${video.youtubeId}`);

  return { variantBuffers: variants, uploadedVariant: "B" };
}

/**
 * Persist decisions as MonitorAction rows, execute them, and record results.
 * UPDATE_TITLE and REGENERATE_THUMBNAIL are NEVER auto-executed — they are
 * sent to Telegram as approval requests regardless of autonomy tier.
 */
export async function executeDecisions(decisions: Decision[]): Promise<void> {
  for (const decision of decisions) {
    if (REQUIRES_APPROVAL.has(decision.type)) {
      // Save as awaiting approval — do NOT execute
      const action = await actions.create({
        data: {
          videoId: decision.videoId,
          type: decision.type,
          payload: decision.payload as any,
          reason: decision.reason,
          status: ActionStatus.AWAITING_APPROVAL,
        },
      });

      await sendApprovalRequest(action.id, decision);
      console.log(
        `[executor] ${decision.type} → AWAITING_APPROVAL — sent to Telegram for approval (action ${action.id})`,
      );
      continue;
    }

    // Auto-execute non-approval actions
    const action = await actions.create({
      data: {
        videoId: decision.videoId,
        type: decision.type,
        payload: decision.payload as any,
        reason: decision.reason,
      },
    });

    const result = await routeAction(decision);

    await actions.update({
      where: { id: action.id },
      data: {
        status: result.success ? ActionStatus.EXECUTED : ActionStatus.FAILED,
        result: result.message,
        executedAt: new Date(),
      },
    });

    console.log(
      `[executor] ${decision.type} → ${result.success ? "OK" : "FAIL"}: ${result.message}`,
    );
  }
}
