import { prisma } from "./lib/prisma";
import { youtube } from "./lib/youtube";
import type { VideoMetrics } from "./lib/types";

/**
 * Fetch current metrics for all uploaded videos and store snapshots.
 * Returns the metrics for downstream stages.
 */
export async function pollVideoMetrics(): Promise<VideoMetrics[]> {
  const videos = await prisma.video.findMany({
    where: { youtubeId: { not: null } },
    select: { id: true, youtubeId: true },
  });

  if (videos.length === 0) {
    console.log("[poller] No uploaded videos to poll");
    return [];
  }

  const youtubeIds = videos.map((v: { id: string; youtubeId: string | null }) => v.youtubeId!);
  const yt = youtube();

  // Batch fetch stats (max 50 per request)
  const metrics: VideoMetrics[] = [];

  for (let i = 0; i < youtubeIds.length; i += 50) {
    const batch = youtubeIds.slice(i, i + 50);
    const res = await yt.videos.list({
      part: ["statistics"],
      id: batch,
    });

    for (const item of res.data.items ?? []) {
      const video = videos.find((v: { id: string; youtubeId: string | null }) => v.youtubeId === item.id);
      if (!video || !item.statistics) continue;

      metrics.push({
        videoId: video.id,
        youtubeId: item.id!,
        views: Number(item.statistics.viewCount ?? 0),
        likes: Number(item.statistics.likeCount ?? 0),
        comments: Number(item.statistics.commentCount ?? 0),
      });
    }
  }

  // Store snapshots
  await prisma.videoSnapshot.createMany({
    data: metrics.map((m) => ({
      videoId: m.videoId,
      views: m.views,
      likes: m.likes,
      comments: m.comments,
    })),
  });

  console.log(`[poller] Stored ${metrics.length} snapshots`);
  return metrics;
}
