import { ActionType } from "./lib/types";
import { prisma } from "./lib/prisma";
import type { BootstrapBenchmarks, Decision, VideoMetrics } from "./lib/types";

const COLD_START_THRESHOLD = 15; // videos needed before using real averages
const HIGH_LIKE_COMMENT = 50; // heart comments with 50+ likes

/**
 * Load baseline benchmarks. If the channel has fewer than COLD_START_THRESHOLD
 * videos worth of snapshots, use bootstrapBenchmarks from ChannelGoal.
 * Otherwise compute from actual data.
 */
async function getBaseline(): Promise<{ ctrThreshold: number; viewsThreshold: number }> {
  const snapshotVideoCount = await prisma.videoSnapshot.groupBy({
    by: ["videoId"],
    _count: true,
  });

  if (snapshotVideoCount.length < COLD_START_THRESHOLD) {
    // Cold start — use bootstrap benchmarks
    const goal = await prisma.channelGoal.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    if (goal?.bootstrapBenchmarks) {
      const bm = goal.bootstrapBenchmarks as unknown as BootstrapBenchmarks;
      console.log(`[decisionEngine] Cold start: using bootstrap benchmarks (${snapshotVideoCount.length}/${COLD_START_THRESHOLD} videos)`);
      return {
        ctrThreshold: bm.avgCtr / 100, // convert percentage to decimal
        viewsThreshold: bm.avgViews48hr,
      };
    }
  }

  // Warm channel — compute from actual snapshots
  const avgCtr = await prisma.videoSnapshot.aggregate({
    _avg: { ctr: true },
    where: { ctr: { not: null } },
  });

  return {
    ctrThreshold: (avgCtr._avg.ctr ?? 3) / 100,
    viewsThreshold: 100,
  };
}

/**
 * Analyze current metrics and recent comments, return suggested actions.
 */
export async function evaluate(
  metrics: VideoMetrics[],
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  const baseline = await getBaseline();

  for (const m of metrics) {
    // ── Check for low CTR → suggest title update ──────────────────
    if (m.ctr !== undefined && m.ctr < baseline.ctrThreshold && m.views > baseline.viewsThreshold) {
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
          reason: `CTR ${(m.ctr * 100).toFixed(1)}% is below ${(baseline.ctrThreshold * 100).toFixed(1)}% threshold`,
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
