import { ActionType } from "./lib/types";
import type { Decision, ActionResult } from "./lib/types";
import { prisma } from "./lib/prisma";
import {
  heartComment,
  updateVideoTitle,
  updateVideoTags,
  updateVideoDescription,
  replyToComment,
  regenerateThumbnail,
} from "./executor";
import { sendAlert, sendThumbnailVariants } from "./telegram";
import { submitRedditPost } from "./redditPoster";

type ActionHandler = (decision: Decision) => Promise<ActionResult>;

const handlers: Record<ActionType, ActionHandler> = {
  [ActionType.HEART_COMMENT]: async (d) => {
    const commentId = d.payload.commentId as string;
    await heartComment(commentId);
    return { success: true, message: `Hearted comment ${commentId}` };
  },

  [ActionType.UPDATE_TITLE]: async (d) => {
    const newTitle = d.payload.newTitle as string | undefined;
    if (!newTitle) {
      return { success: false, message: "No newTitle in payload" };
    }
    await updateVideoTitle(d.videoId, newTitle);
    return { success: true, message: `Updated title to "${newTitle}"` };
  },

  [ActionType.UPDATE_TAGS]: async (d) => {
    const tags = d.payload.tags as string[] | undefined;
    if (!tags || tags.length === 0) {
      return { success: false, message: "No tags in payload" };
    }
    await updateVideoTags(d.videoId, tags);
    return { success: true, message: `Updated tags: [${tags.join(", ")}]` };
  },

  [ActionType.UPDATE_DESCRIPTION]: async (d) => {
    const newDescription = d.payload.newDescription as string | undefined;
    if (!newDescription) {
      return { success: false, message: "No newDescription in payload" };
    }
    await updateVideoDescription(d.videoId, newDescription);
    return { success: true, message: `Updated description for ${d.videoId}` };
  },

  [ActionType.REGENERATE_THUMBNAIL]: async (d) => {
    const { variantBuffers, uploadedVariant } = await regenerateThumbnail(d.videoId);
    const video = await prisma.video.findUnique({
      where: { id: d.videoId },
      select: { seoTitle: true, youtubeId: true },
    });
    // Send all 3 variants to Telegram
    await sendThumbnailVariants(
      variantBuffers,
      video?.seoTitle ?? "Unknown",
      video?.youtubeId ?? "",
    );
    return { success: true, message: `Thumbnail regenerated and variant ${uploadedVariant} uploaded` };
  },

  [ActionType.PIN_COMMENT]: async (d) => {
    const commentText = (d.payload.commentText as string) ?? "N/A";
    const video = await prisma.video.findUnique({
      where: { id: d.videoId },
      select: { youtubeId: true, seoTitle: true },
    });
    const studioLink = `https://studio.youtube.com/video/${video?.youtubeId ?? ""}/comments`;
    await sendAlert(
      `Pin this comment\n\nVideo: "${video?.seoTitle ?? d.videoId}"\nComment: "${commentText}"\n\n${studioLink}`,
    );
    return { success: true, message: `Pin comment alert sent` };
  },

  [ActionType.REPLY_COMMENT]: async (d) => {
    const commentId = d.payload.commentId as string | undefined;
    const replyText = d.payload.replyText as string | undefined;
    if (!commentId || !replyText) {
      return { success: false, message: "Missing commentId or replyText in payload" };
    }
    await replyToComment(commentId, replyText);
    return { success: true, message: `Replied to comment ${commentId}` };
  },

  [ActionType.COMMUNITY_POST]: async (d) => {
    const draftText = (d.payload.draftText as string) ?? "";
    const ytId = (d.payload.youtubeId as string) ?? "";
    await sendAlert(
      `Community Post Draft (copy-paste to YouTube)\n\n${draftText}\n\nVideo: https://youtu.be/${ytId}\n\nPost at: https://studio.youtube.com/channel/community`,
    );
    return { success: true, message: "Community post draft sent to Telegram" };
  },

  [ActionType.END_SCREEN]: async (d) => {
    const suggestedTitle = (d.payload.suggestedTitle as string) ?? "";
    const suggestedYtId = (d.payload.suggestedYoutubeId as string) ?? "";
    const reasoning = (d.payload.reasoning as string) ?? "";
    const video = await prisma.video.findUnique({
      where: { id: d.videoId },
      select: { youtubeId: true, seoTitle: true },
    });
    await sendAlert(
      `End Screen Suggestion\n\nVideo: "${video?.seoTitle ?? d.videoId}"\nLink as end screen: "${suggestedTitle}" (https://youtu.be/${suggestedYtId})\n\nReasoning: ${reasoning}\n\nSet at: https://studio.youtube.com/video/${video?.youtubeId ?? ""}/editor`,
    );
    return { success: true, message: "End screen suggestion sent" };
  },

  [ActionType.REPROMOTE]: async (d) => {
    const draftText = (d.payload.draftText as string) ?? "";
    const ytId = (d.payload.youtubeId as string) ?? "";
    const views = d.payload.views as number ?? 0;
    const avgViews = d.payload.avgViews as number ?? 0;
    await sendAlert(
      `Re-Promotion Draft (copy-paste to YouTube Community)\n\n${draftText}\n\nVideo: https://youtu.be/${ytId}\nViews: ${views} (channel avg: ${Math.round(avgViews)})\n\nPost at: https://studio.youtube.com/channel/community`,
    );
    return { success: true, message: "Re-promotion draft sent to Telegram" };
  },

  [ActionType.REDDIT_POST]: async (d) => {
    return submitRedditPost(d.videoId);
  },

  [ActionType.GENERATE_SHORT]: async () => {
    return { success: false, message: "Shorts generation moved to pipeline — no longer handled by monitor" };
  },

  [ActionType.ALERT]: async (d) => {
    await sendAlert(`${d.reason} (video ${d.videoId})`);
    return { success: true, message: "Alert sent" };
  },
};

/**
 * Route a decision to the appropriate handler and return the result.
 */
export async function routeAction(decision: Decision): Promise<ActionResult> {
  const handler = handlers[decision.type];
  try {
    return await handler(decision);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}
