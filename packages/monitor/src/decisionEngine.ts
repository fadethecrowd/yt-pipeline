import { ActionType } from "./lib/types";
import { prisma } from "./lib/prisma";
import type { Decision, VideoMetrics } from "./lib/types";

const LOW_CTR_THRESHOLD = 0.03; // 3%
const HIGH_LIKE_COMMENT = 50; // heart comments with 50+ likes

/**
 * Analyze current metrics and recent comments, return suggested actions.
 */
export async function evaluate(
  metrics: VideoMetrics[],
): Promise<Decision[]> {
  const decisions: Decision[] = [];

  for (const m of metrics) {
    // ── Check for low CTR → suggest title update ──────────────────
    if (m.ctr !== undefined && m.ctr < LOW_CTR_THRESHOLD && m.views > 100) {
      const existing = await prisma.monitorAction.findFirst({
        where: {
          videoId: m.videoId,
          type: ActionType.UPDATE_TITLE,
          status: { in: ["PENDING", "EXECUTED"] },
        },
      });
      if (!existing) {
        decisions.push({
          videoId: m.videoId,
          type: ActionType.UPDATE_TITLE,
          payload: { currentCtr: m.ctr, views: m.views },
          reason: `CTR ${(m.ctr * 100).toFixed(1)}% is below ${LOW_CTR_THRESHOLD * 100}% threshold`,
        });
      }
    }

    // ── Heart high-engagement comments ────────────────────────────
    const unhearted = await prisma.comment.findMany({
      where: {
        videoId: m.videoId,
        likeCount: { gte: HIGH_LIKE_COMMENT },
        isHearted: false,
      },
    });

    for (const comment of unhearted) {
      decisions.push({
        videoId: m.videoId,
        type: ActionType.HEART_COMMENT,
        payload: { commentId: comment.youtubeCommentId, likeCount: comment.likeCount },
        reason: `Comment by ${comment.authorName} has ${comment.likeCount} likes`,
      });
    }

    // ── Alert on rapid view growth ───────────────────────────────
    const snapshots = await prisma.videoSnapshot.findMany({
      where: { videoId: m.videoId },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    if (snapshots.length === 2) {
      const viewDelta = snapshots[0].views - snapshots[1].views;
      if (viewDelta > 1000) {
        decisions.push({
          videoId: m.videoId,
          type: ActionType.ALERT,
          payload: { viewDelta, currentViews: m.views },
          reason: `Rapid growth: +${viewDelta} views since last poll`,
        });
      }
    }
  }

  console.log(`[decisionEngine] Generated ${decisions.length} decisions`);
  return decisions;
}
