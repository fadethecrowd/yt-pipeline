import { videos, snapshots } from "./lib/channelDb";
import { youtube, youtubeAnalytics } from "./lib/youtube";
import { liveVideoWhere } from "./lib/queries";
import { parseIsoDurationSeconds, isShortVideo, videoTypeLabel } from "./lib/videoType";
import type { VideoMetrics } from "./lib/types";

interface AnalyticsData {
  analyticsViews?: number;        // Analytics 28d views (separate from Data API all-time)
  impressions?: number;           // from videoThumbnailImpressions
  ctr?: number;                   // from videoThumbnailImpressionsClickRate (ratio 0..1)
  avgViewDuration?: number;
  avgViewPercentage?: number;
  estimatedMinutesWatched?: number;
}

// Analytics runs as two DIFFERENT-SHAPED reports per tick:
//
//   Query A — user-activity, per pipeline video.
//     ids=channel==MINE, filters=video==<ytId>, no dimensions.
//     Always on.
//
//   Query B — reach, channel-wide ONCE per tick.
//     ids=channel==MINE, dimensions=video, sort=-videoThumbnailImpressions,
//     maxResults=200, NO video filter. This is the "Top videos" report
//     shape — the documented way to request videoThumbnailImpressions and
//     videoThumbnailImpressionsClickRate. Per-tick results are looked up
//     by youtubeId to merge into each per-video row.
//
//     Gated behind ENABLE_REACH_METRICS=true (default OFF). As of this
//     commit the thumbnail-reach metric family appears unavailable for
//     the channels this service operates on — every documented shape
//     returns "The query is not supported" against a token that carries
//     yt-analytics.readonly and whose identical shape succeeds for other
//     metrics (e.g. `views`). We tried per-video filters, channel-wide
//     with sort+maxResults, single-metric and paired, with day / video /
//     creatorContentType dimensions — all rejected. The same request
//     shape may start returning data once a channel's eligibility
//     changes; keeping the code path intact so re-enabling is a single
//     env-var flip, no code change.
const METRICS_USER_ACTIVITY =
  "views,averageViewDuration,averageViewPercentage,estimatedMinutesWatched";
const METRICS_REACH =
  "videoThumbnailImpressions,videoThumbnailImpressionsClickRate";
const REACH_SORT = "-videoThumbnailImpressions";
const REACH_MAX_RESULTS = 200;

function reachEnabled(): boolean {
  return process.env.ENABLE_REACH_METRICS === "true";
}

function dateWindow(): { startDate: string; endDate: string } {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { startDate, endDate };
}

type AnalyticsScope = "user-activity" | "reach";

interface AnalyticsCounters {
  userActivityOk: number;
  userActivityFail: number;
  reachOk: number;
  reachFail: number;
  reachSkipped: boolean;
}

function scopeToLabel(scope: AnalyticsScope): "QUERY_A" | "QUERY_B" {
  return scope === "user-activity" ? "QUERY_A" : "QUERY_B";
}

/**
 * Run one Analytics query and return the data rows array (or null on
 * empty/failure). Emits a pre-request [analytics/debug] log block showing
 * the exact request shape, and a structured [poller/error] block on
 * failure. Failures resolve to null rather than throwing so the caller
 * can merge whatever DID succeed.
 *
 * When `dimensions` is set, the API returns one row per dimension value
 * (e.g. per day) with the dimension columns FIRST, followed by metric
 * columns in the order of the `metrics` string. Callers that pass a
 * dimension must account for the leading dimension column(s).
 */
async function runAnalyticsQuery(
  youtubeId: string,
  metrics: string,
  scope: AnalyticsScope,
  counters: AnalyticsCounters,
  dimensions?: string,
): Promise<Array<Array<number | string>> | null> {
  const yta = youtubeAnalytics();
  const { startDate, endDate } = dateWindow();
  const ids = "channel==MINE";
  const filters = `video==${youtubeId}`;
  const label = scopeToLabel(scope);

  console.log(
    `[analytics/debug] ${label}\n` +
      `ids=${ids}\n` +
      `metrics=${metrics}\n` +
      `dimensions=${dimensions ?? "none"}\n` +
      `filters=${filters}\n` +
      `startDate=${startDate}\n` +
      `endDate=${endDate}`,
  );

  try {
    const res = await yta.reports.query({
      ids,
      startDate,
      endDate,
      metrics,
      filters,
      ...(dimensions ? { dimensions } : {}),
    });
    if (scope === "user-activity") counters.userActivityOk++;
    else counters.reachOk++;
    return (res.data.rows as Array<Array<number | string>> | undefined) ?? null;
  } catch (err: any) {
    if (scope === "user-activity") counters.userActivityFail++;
    else counters.reachFail++;
    // Prefer the structured Google API error message (e.g. "The query is
    // not supported") over the generic transport-level wrapper.
    const apiError =
      err?.response?.data?.error?.message ??
      (err instanceof Error ? err.message : String(err));
    console.warn(
      `[poller/error] ANALYTICS_QUERY_FAILED\n` +
        `type=${scope}\n` +
        `yt=${youtubeId}\n` +
        `metrics=${metrics}\n` +
        `dimensions=${dimensions ?? "none"}\n` +
        `filters=${filters}\n` +
        `error=${apiError}`,
    );
    return null;
  }
}

/**
 * Query YouTube Analytics v2 for a single video's user-activity metrics
 * (views, watch time). Reach metrics (impressions + CTR) are fetched
 * separately by fetchChannelReach() — the reach report does not support
 * a per-video filter shape.
 */
async function fetchUserActivity(
  youtubeId: string,
  counters: AnalyticsCounters,
): Promise<AnalyticsData> {
  const rows = await runAnalyticsQuery(
    youtubeId,
    METRICS_USER_ACTIVITY,
    "user-activity",
    counters,
  );

  const out: AnalyticsData = {};
  // Row mapping (METRICS_USER_ACTIVITY order, no dimensions):
  //   row[0] views                        → analyticsViews
  //   row[1] averageViewDuration          (seconds, integer)
  //   row[2] averageViewPercentage        (0..100)
  //   row[3] estimatedMinutesWatched      (integer)
  const row = rows?.[0];
  if (row) {
    if (row[0] != null) out.analyticsViews          = Number(row[0]);
    if (row[1] != null) out.avgViewDuration         = Number(row[1]);
    if (row[2] != null) out.avgViewPercentage       = Number(row[2]);
    if (row[3] != null) out.estimatedMinutesWatched = Number(row[3]);
  }
  return out;
}

/**
 * Channel-wide reach retrieval — ONE API call per tick, not per video.
 *
 * Emits its own [analytics/debug] QUERY_B block and increments the reach
 * counter (ok or fail). On failure, emits a structured [poller/error]
 * ANALYTICS_QUERY_FAILED block and returns an empty map; callers treat
 * missing entries as "no reach data for this video".
 *
 * Returns Map<youtubeId, {impressions, ctr}> keyed by YouTube video ID.
 * A pipeline video absent from the map (new upload, ranked below
 * maxResults, or zero channel-side impressions in the 28d window) is
 * correctly treated as impressions=null, ctr=null downstream.
 */
async function fetchChannelReach(
  counters: AnalyticsCounters,
): Promise<Map<string, { impressions: number; ctr: number }>> {
  const yta = youtubeAnalytics();
  const { startDate, endDate } = dateWindow();
  const ids = "channel==MINE";
  const dimensions = "video";
  const metrics = METRICS_REACH;

  console.log(
    `[analytics/debug] QUERY_B\n` +
      `ids=${ids}\n` +
      `metrics=${metrics}\n` +
      `dimensions=${dimensions}\n` +
      `filters=none\n` +
      `sort=${REACH_SORT}\n` +
      `maxResults=${REACH_MAX_RESULTS}\n` +
      `startDate=${startDate}\n` +
      `endDate=${endDate}`,
  );

  const result = new Map<string, { impressions: number; ctr: number }>();

  try {
    const res = await yta.reports.query({
      ids,
      startDate,
      endDate,
      metrics,
      dimensions,
      sort: REACH_SORT,
      maxResults: REACH_MAX_RESULTS,
    });
    counters.reachOk++;
    const rows = (res.data.rows ?? []) as Array<Array<number | string>>;
    // Row column order: [video_id, videoThumbnailImpressions, videoThumbnailImpressionsClickRate]
    for (const row of rows) {
      const videoId = String(row[0]);
      const impressions = row[1] != null ? Number(row[1]) : 0;
      const ctr = row[2] != null ? Number(row[2]) : 0;
      result.set(videoId, { impressions, ctr });
    }
    return result;
  } catch (err: any) {
    counters.reachFail++;
    const apiError =
      err?.response?.data?.error?.message ??
      (err instanceof Error ? err.message : String(err));
    console.warn(
      `[poller/error] ANALYTICS_QUERY_FAILED\n` +
        `type=reach\n` +
        `yt=<channel-wide>\n` +
        `metrics=${metrics}\n` +
        `dimensions=${dimensions}\n` +
        `filters=none\n` +
        `sort=${REACH_SORT}\n` +
        `maxResults=${REACH_MAX_RESULTS}\n` +
        `error=${apiError}`,
    );
    return result;
  }
}

/**
 * Fetch current metrics for all uploaded videos and store snapshots.
 * Returns the metrics for downstream stages.
 */
export async function pollVideoMetrics(): Promise<VideoMetrics[]> {
  const videoRows = await videos.findMany({
    where: {
      ...liveVideoWhere,
      // Only poll videos that have already published (scheduledAt in the past or null)
      OR: [
        { scheduledAt: { lte: new Date() } },
        { scheduledAt: null },
      ],
    },
    select: { id: true, youtubeId: true, shortsUrl: true },
  });

  if (videoRows.length === 0) {
    console.log("[poller] No uploaded videos to poll");
    return [];
  }

  const youtubeIds = videoRows.map((v: { id: string; youtubeId: string | null; shortsUrl: string | null }) => v.youtubeId!);

  // Extract Short YouTube IDs from shortsUrl (format: https://youtube.com/shorts/<id>).
  // Build a reverse-lookup map so batch results can be matched back to the
  // internal Video.id that owns the Short.
  const shortIdToVideoId = new Map<string, string>();
  for (const row of videoRows) {
    if (row.shortsUrl) {
      const shortId = row.shortsUrl.split("/shorts/")[1];
      if (shortId) shortIdToVideoId.set(shortId, row.id);
    }
  }
  // Merge long-form IDs and Short IDs into one deduplicated list so both are
  // fetched in the same batched yt.videos.list() calls below.
  const allYoutubeIds = [...new Set([...youtubeIds, ...shortIdToVideoId.keys()])];
  const yt = youtube();

  // Batch fetch basic stats (max 50 per request)
  const metrics: VideoMetrics[] = [];

  for (let i = 0; i < allYoutubeIds.length; i += 50) {
    const batch = allYoutubeIds.slice(i, i + 50);
    const res = await yt.videos.list({
      part: ["statistics", "contentDetails"],
      id: batch,
    });

    const returnedIds = new Set<string>();
    for (const item of res.data.items ?? []) {
      if (item.id) returnedIds.add(item.id);
      const longFormRow = videoRows.find((v: { id: string; youtubeId: string | null; shortsUrl: string | null }) => v.youtubeId === item.id);
      const shortOwnerVideoId = shortIdToVideoId.get(item.id!);
      const videoId = longFormRow?.id ?? shortOwnerVideoId;
      if (!videoId || !item.statistics) continue;

      // Short vs long-form: Short IDs (from shortsUrl) are always Shorts.
      // For long-form IDs fall back to duration-based detection as before.
      const isShortEntry = shortIdToVideoId.has(item.id!);
      const durationSeconds = parseIsoDurationSeconds(
        item.contentDetails?.duration ?? null,
      );

      metrics.push({
        videoId,
        youtubeId: item.id!,
        views: Number(item.statistics.viewCount ?? 0),
        likes: Number(item.statistics.likeCount ?? 0),
        comments: Number(item.statistics.commentCount ?? 0),
        durationSeconds,
        isShort: isShortEntry || isShortVideo(durationSeconds),
      });
    }

    // Ghost-ID detection: any requested ytId the API did NOT return is
    // most likely deleted from YouTube (owner-authenticated private
    // videos DO come back in this response, so absence = deletion). Log
    // a distinctive warning so ghosts surface in production logs
    // immediately rather than drifting silently. No DB mutation here —
    // operator decides whether to run a cleanup like the one in
    // scripts/ghost-repair history.
    for (const requested of batch) {
      if (!returnedIds.has(requested)) {
        const videoRow = videoRows.find((v: { id: string; youtubeId: string | null; shortsUrl: string | null }) => v.youtubeId === requested);
        const dbRowId = videoRow?.id ?? shortIdToVideoId.get(requested);
        console.warn(
          `[poller/ghost] youtubeId=${requested} requested but not returned by YouTube — ` +
            `video likely deleted. DB row: ${dbRowId ?? "(not found)"}`,
        );
      }
    }
  }

  // Fetch analytics. Counters are scoped to this tick so the end-of-cycle
  // [poller/summary] reflects only this run.
  //
  // Reach is ONE channel-wide call; user-activity is per video. Reach
  // results are looked up by youtubeId and merged into each per-video
  // AnalyticsData entry — videos absent from the reach rows get
  // impressions/ctr as undefined (→ null in DB), which is correct for
  // new uploads or videos below the maxResults cutoff.
  const analyticsMap = new Map<string, AnalyticsData>();
  const counters: AnalyticsCounters = {
    userActivityOk: 0,
    userActivityFail: 0,
    reachOk: 0,
    reachFail: 0,
    reachSkipped: false,
  };

  // Reach query is opt-in. When disabled we skip silently — no API call,
  // no QUERY_B log block, no reach failure noise. Per-video impressions/ctr
  // stay undefined and persist as null in VideoSnapshot (unchanged behavior
  // from before the reach code existed).
  const reachMap = reachEnabled()
    ? await fetchChannelReach(counters)
    : (counters.reachSkipped = true, new Map<string, { impressions: number; ctr: number }>());

  for (const m of metrics) {
    const userActivity = await fetchUserActivity(m.youtubeId, counters);
    const reach = reachMap.get(m.youtubeId);
    const merged: AnalyticsData = {
      ...userActivity,
      ...(reach ? { impressions: reach.impressions, ctr: reach.ctr } : {}),
    };
    analyticsMap.set(m.videoId, merged);
    if (merged.ctr !== undefined) m.ctr = merged.ctr;
    if (merged.avgViewDuration !== undefined) m.avgViewDuration = merged.avgViewDuration;
    if (merged.avgViewPercentage !== undefined) m.avgViewPercentage = merged.avgViewPercentage;
    if (merged.estimatedMinutesWatched !== undefined) m.estimatedMinutesWatched = merged.estimatedMinutesWatched;
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
        isShort: m.isShort ?? false,
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
    const typeLabel = videoTypeLabel(m.durationSeconds ?? 0);
    console.log(
      `[poller/debug] #${i + 1}/${metrics.length} vid=${m.videoId} yt=${m.youtubeId} ` +
        `type=${typeLabel} dur=${m.durationSeconds ?? "n/a"}s ` +
        `views=${m.views} analytics.views=${a.analyticsViews ?? "n/a"} ` +
        `impressions=${a.impressions ?? "n/a"} ctr=${ctrPct}`,
    );
  }

  console.log(`[poller] Stored ${metrics.length} snapshots (with analytics)`);

  // End-of-cycle summary — counts of successful vs. failed Analytics
  // queries across this tick, per metric family. Emitted last so it is
  // easy to locate at the tail of each tick's log block.
  const reachLine = counters.reachSkipped
    ? "reach skipped (ENABLE_REACH_METRICS=false)"
    : `reach ok=${counters.reachOk} fail=${counters.reachFail}`;
  console.log(
    `[poller/summary]\n` +
      `userActivity ok=${counters.userActivityOk} fail=${counters.userActivityFail}\n` +
      reachLine,
  );

  return metrics;
}
