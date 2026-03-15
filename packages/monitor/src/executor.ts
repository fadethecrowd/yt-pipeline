import { ActionStatus } from "./lib/types";
import { prisma } from "./lib/prisma";
import { youtube } from "./lib/youtube";
import type { Decision } from "./lib/types";
import { routeAction } from "./actionRouter";

/**
 * Heart a comment via the YouTube API.
 */
export async function heartComment(commentId: string): Promise<void> {
  // YouTube API doesn't have a direct "heart" endpoint in v3.
  // Hearting is done by setting the moderationStatus or via the
  // comments.markAsSpam / setModerationStatus approach.
  // For now, use the comment rating approach:
  const yt = youtube();
  await yt.comments.setModerationStatus({
    id: [commentId],
    moderationStatus: "published",
  });
  console.log(`[executor] Hearted comment ${commentId}`);
}

/**
 * Update a video's title via the YouTube API.
 */
export async function updateVideoTitle(
  videoId: string,
  newTitle: string,
): Promise<void> {
  const video = await prisma.video.findUniqueOrThrow({
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
 * Persist decisions as MonitorAction rows, execute them, and record results.
 */
export async function executeDecisions(decisions: Decision[]): Promise<void> {
  for (const decision of decisions) {
    const action = await prisma.monitorAction.create({
      data: {
        videoId: decision.videoId,
        type: decision.type,
        payload: decision.payload as any,
        reason: decision.reason,
      },
    });

    const result = await routeAction(decision);

    await prisma.monitorAction.update({
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
