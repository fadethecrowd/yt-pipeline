import { prisma } from "./lib/prisma";
import { youtube, youtubeAnalytics } from "./lib/youtube";
import type { VideoMetrics } from "./lib/types";

interface AnalyticsData {
  ctr?: number;
  impressions?: number;
  avgViewPercentage?: number;
  estimatedMinutesWatched?: number;
  avgViewDuration?: number;
}

/**
 * Query YouTube Analytics for a single video's CTR, impressions,
 * averageViewPercentage, and estimatedMinutesWatched.
 */
async function fetchAnalytics(youtubeId: string): Promise<AnalyticsData> {
  const yta = youtubeAnalytics();

  // Query last 28 days of data
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "annotationClickThroughRate,impressions,averageViewPercentage,estimatedMinutesWatched,averageViewDuration",
      filters: `video==${youtubeId}`,
    });

    const row = res.data.rows?.[0];
    if (!row) return {};

    return {
      ctr: row[0] != null ? Number(row[0]) : undefined,
      impressions: row[1] != null ? Number(row[1]) : undefined,
      avgViewPercentage: row[2] != null ? Number(row[2]) : undefined,
      estimatedMinutesWatched: row[3] != null ? Number(row[3]) : undefined,
      avgViewDuration: row[4] != null ? Number(row[4]) : undefined,
    };
  } catch (err) {
    console.warn(`[poller] Analytics fetch failed for ${youtubeId}: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

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

  // Batch fetch basic stats (max 50 per request)
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

  // Fetch analytics for each video and enrich metrics
  const analyticsMap = new Map<string, AnalyticsData>();
  for (const m of metrics) {
    const analytics = await fetchAnalytics(m.youtubeId);
    analyticsMap.set(m.videoId, analytics);
    if (analytics.ctr !== undefined) m.ctr = analytics.ctr;
    if (analytics.avgViewDuration !== undefined) m.avgViewDuration = analytics.avgViewDuration;
  }

  // Store snapshots with analytics data
  await prisma.videoSnapshot.createMany({
    data: metrics.map((m) => {
      const a = analyticsMap.get(m.videoId) ?? {};
      return {
        videoId: m.videoId,
        views: m.views,
        likes: m.likes,
        comments: m.comments,
        ctr: a.ctr ?? null,
        impressions: a.impressions ?? null,
        avgViewDuration: a.avgViewDuration ?? null,
        avgViewPercentage: a.avgViewPercentage ?? null,
        estimatedMinutesWatched: a.estimatedMinutesWatched ?? null,
      };
    }),
  });

  console.log(`[poller] Stored ${metrics.length} snapshots (with analytics)`);
  return metrics;
}
