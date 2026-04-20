import { videos, snapshots } from "./lib/channelDb";
import { youtube, youtubeAnalytics } from "./lib/youtube";
import type { VideoMetrics } from "./lib/types";

interface AnalyticsData {
  analyticsViews?: number;        // Analytics 28d views (separate from Data API all-time)
  impressions?: number;           // from videoThumbnailImpressions
  ctr?: number;                   // from videoThumbnailImpressionsClickRate (ratio 0..1)
  avgViewDuration?: number;
  avgViewPercentage?: number;
  estimatedMinutesWatched?: number;
}

// Analytics metrics requested, in the order the API returns them.
// Order is load-bearing: row indices below match this list.
//
// Previously requested "annotationClickThroughRate" — annotations were
// deprecated by YouTube in 2019 and that metric returns ~0 for every modern
// video, which is why every stored ctr in production was 0.
// An interim attempt with "impressions,impressionClickThroughRate" was
// rejected by the API ("Unknown identifier (impressions) given in field
// parameters.metrics."). The correct identifiers for Studio-equivalent
// thumbnail reach are videoThumbnailImpressions and
// videoThumbnailImpressionsClickRate.
const ANALYTICS_METRICS =
  "views,videoThumbnailImpressions,videoThumbnailImpressionsClickRate,averageViewDuration,averageViewPercentage,estimatedMinutesWatched";

/**
 * Query YouTube Analytics v2 for a single video's views, impressions,
 * impressionClickThroughRate, and watch-time metrics over the last 28 days.
 */
async function fetchAnalytics(youtubeId: string): Promise<AnalyticsData> {
  const yta = youtubeAnalytics();

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: ANALYTICS_METRICS,
      filters: `video==${youtubeId}`,
    });

    const row = res.data.rows?.[0];
    if (!row) return {};

    // Row mapping — mirrors ANALYTICS_METRICS order:
    //   row[0] views                                → analyticsViews
    //   row[1] videoThumbnailImpressions            → impressions
    //   row[2] videoThumbnailImpressionsClickRate   → ctr (ratio 0..1)
    //   row[3] averageViewDuration (seconds, integer)
    //   row[4] averageViewPercentage (0..100)
    //   row[5] estimatedMinutesWatched (integer)
    return {
      analyticsViews:          row[0] != null ? Number(row[0]) : undefined,
      impressions:             row[1] != null ? Number(row[1]) : undefined,
      ctr:                     row[2] != null ? Number(row[2]) : undefined,
      avgViewDuration:         row[3] != null ? Number(row[3]) : undefined,
      avgViewPercentage:       row[4] != null ? Number(row[4]) : undefined,
      estimatedMinutesWatched: row[5] != null ? Number(row[5]) : undefined,
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
  const videoRows = await videos.findMany({
    where: {
      youtubeId: { not: null },
      // Only poll videos that have already published (scheduledAt in the past or null)
      OR: [
        { scheduledAt: { lte: new Date() } },
        { scheduledAt: null },
      ],
    },
    select: { id: true, youtubeId: true },
  });

  if (videoRows.length === 0) {
    console.log("[poller] No uploaded videos to poll");
    return [];
  }

  const youtubeIds = videoRows.map((v: { id: string; youtubeId: string | null }) => v.youtubeId!);
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
      const video = videoRows.find((v: { id: string; youtubeId: string | null }) => v.youtubeId === item.id);
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

  // Store snapshots with analytics data. `impressions` is now included
  // (previously omitted, which is why VideoSnapshot.impressions was NULL
  // on every historical row).
  await snapshots.createMany({
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

  // Debug log for the first 10 snapshots of this tick so ingestion can be
  // verified end-to-end without querying the DB. Capped at 10 to avoid
  // flooding logs on channels with many published videos.
  const DEBUG_CAP = 10;
  for (let i = 0; i < Math.min(DEBUG_CAP, metrics.length); i++) {
    const m = metrics[i];
    const a = analyticsMap.get(m.videoId) ?? {};
    const ctrPct = a.ctr !== undefined ? `${(a.ctr * 100).toFixed(3)}%` : "n/a";
    console.log(
      `[poller/debug] #${i + 1}/${metrics.length} vid=${m.videoId} yt=${m.youtubeId} ` +
        `views=${m.views} analytics.views=${a.analyticsViews ?? "n/a"} ` +
        `impressions=${a.impressions ?? "n/a"} ctr=${ctrPct}`,
    );
  }

  console.log(`[poller] Stored ${metrics.length} snapshots (with analytics)`);
  return metrics;
}
