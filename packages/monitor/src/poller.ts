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

// Analytics is split into two targeted queries per video because YouTube
// Analytics rejects a combined user-activity + reach metrics list with
// "The query is not supported." Each dimension set has its own supported
// metric family; merging results in code instead lets us keep partial
// data when only one family is available for a given video/token.
//
// History:
//   1. annotationClickThroughRate (deprecated 2019 — always 0)
//   2. impressions + impressionClickThroughRate (unknown identifier)
//   3. videoThumbnailImpressions[ClickRate] in a combined query
//      ("The query is not supported")
//   4. current: two queries, merged
const METRICS_USER_ACTIVITY =
  "views,averageViewDuration,averageViewPercentage,estimatedMinutesWatched";
const METRICS_REACH =
  "videoThumbnailImpressions,videoThumbnailImpressionsClickRate";

function dateWindow(): { startDate: string; endDate: string } {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { startDate, endDate };
}

/**
 * Run one Analytics query and return the first data row (or null on
 * empty/failure). Failures log a scoped warning and resolve to null
 * rather than throwing, so the caller can merge whatever DID succeed.
 */
async function runAnalyticsQuery(
  youtubeId: string,
  metrics: string,
  scopeLabel: "user-activity" | "reach",
): Promise<Array<number | string> | null> {
  const yta = youtubeAnalytics();
  const { startDate, endDate } = dateWindow();
  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics,
      filters: `video==${youtubeId}`,
    });
    return (res.data.rows?.[0] as Array<number | string> | undefined) ?? null;
  } catch (err) {
    console.warn(
      `[poller] Analytics ${scopeLabel} fetch failed for ${youtubeId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Query YouTube Analytics v2 for a single video, combining results from a
 * user-activity query (views, watch time) and a reach query (thumbnail
 * impressions + click-through rate). Either query can fail independently;
 * fields from the other query are preserved.
 */
async function fetchAnalytics(youtubeId: string): Promise<AnalyticsData> {
  const [rowA, rowB] = await Promise.all([
    runAnalyticsQuery(youtubeId, METRICS_USER_ACTIVITY, "user-activity"),
    runAnalyticsQuery(youtubeId, METRICS_REACH, "reach"),
  ]);

  const merged: AnalyticsData = {};

  // Query A — user-activity row mapping (METRICS_USER_ACTIVITY order):
  //   row[0] views                        → analyticsViews
  //   row[1] averageViewDuration          (seconds, integer)
  //   row[2] averageViewPercentage        (0..100)
  //   row[3] estimatedMinutesWatched      (integer)
  if (rowA) {
    if (rowA[0] != null) merged.analyticsViews          = Number(rowA[0]);
    if (rowA[1] != null) merged.avgViewDuration         = Number(rowA[1]);
    if (rowA[2] != null) merged.avgViewPercentage       = Number(rowA[2]);
    if (rowA[3] != null) merged.estimatedMinutesWatched = Number(rowA[3]);
  }

  // Query B — reach row mapping (METRICS_REACH order):
  //   row[0] videoThumbnailImpressions             → impressions
  //   row[1] videoThumbnailImpressionsClickRate    → ctr (ratio 0..1)
  if (rowB) {
    if (rowB[0] != null) merged.impressions = Number(rowB[0]);
    if (rowB[1] != null) merged.ctr         = Number(rowB[1]);
  }

  return merged;
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
