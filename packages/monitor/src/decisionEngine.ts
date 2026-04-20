import Anthropic from "@anthropic-ai/sdk";
import { ActionType } from "./lib/types";
import { videos, snapshots, comments, actions, goal as goalDb } from "./lib/channelDb";
import { env } from "./config";
import type { BootstrapBenchmarks, Decision, VideoMetrics } from "./lib/types";

const COLD_START_THRESHOLD = 15; // videos needed before using real averages
const HIGH_LIKE_COMMENT = 3; // heart comments with 3+ likes

// Minimum CTR threshold floor. Guards against a degenerate "every video
// passes" state when YouTube Analytics has not yet returned real CTR data
// — i.e. AVG(snapshots.ctr) collapses to 0 for a freshly-warm channel,
// which would otherwise make every non-null CTR "above threshold" and
// suppress all rewrite suggestions.
const MIN_CTR_THRESHOLD = 0.03; // 3%

// Warm-channel minimum view count before a rewrite can be considered.
// Lowered from 100 → 50 so a 70-view dud can still trigger a title
// rewrite rather than sitting in SKIPPED_BASELINE forever.
const WARM_VIEWS_THRESHOLD = 50;

interface Baseline {
  ctrThreshold: number;
  viewsThreshold: number;
  goalText: string | null;
  bootstrapBenchmarks: BootstrapBenchmarks | null;
}

/**
 * Load baseline benchmarks. If the channel has fewer than COLD_START_THRESHOLD
 * videos worth of snapshots, use bootstrapBenchmarks from ChannelGoal.
 * Otherwise compute from actual data.
 */
async function getBaseline(): Promise<Baseline> {
  // ── 1. ChannelGoal lookup (current channel only) ────────────────────
  const goal = await goalDb.find();

  if (goal) {
    console.log(`[decisionEngine] ChannelGoal FOUND (channel=${goal.channel}, id=${goal.id}, goal="${goal.goal}")`);
  } else {
    console.log(`[decisionEngine] ChannelGoal NOT FOUND for this channel — no goal set`);
  }

  let bm: BootstrapBenchmarks | null = null;
  if (goal?.bootstrapBenchmarks) {
    bm = goal.bootstrapBenchmarks as unknown as BootstrapBenchmarks;
    console.log(
      `[decisionEngine]   bootstrapBenchmarks: avgCtr=${bm.avgCtr}%, avgViews48hr=${bm.avgViews48hr}, avgViewDuration=${bm.avgViewDuration}s, avgSubsPerVideo=${bm.avgSubsPerVideo}`,
    );
  }

  // ── 2. Count unique videos with snapshots ───────────────────────────
  const snapshotVideoCount = await snapshots.groupBy({
    by: ["videoId"],
    _count: true,
  });

  if (snapshotVideoCount.length < COLD_START_THRESHOLD && bm) {
    // Cold start — use bootstrap benchmarks
    const result: Baseline = {
      ctrThreshold: bm.avgCtr / 100, // convert percentage to decimal
      viewsThreshold: bm.avgViews48hr,
      goalText: goal?.goal ?? null,
      bootstrapBenchmarks: bm,
    };
    console.log(
      `[decisionEngine] Cold start (${snapshotVideoCount.length}/${COLD_START_THRESHOLD} videos) — using bootstrap benchmarks`,
    );
    console.log(
      `[decisionEngine] Channel averages → ctrThreshold: ${(result.ctrThreshold * 100).toFixed(2)}%, viewsThreshold: ${result.viewsThreshold}`,
    );
    return result;
  }

  // Warm channel — compute from actual snapshots (current channel only)
  const avgCtr = await snapshots.aggregate({
    _avg: { ctr: true },
    where: { ctr: { not: null } },
  });

  const computedCtr = avgCtr._avg?.ctr ?? 3;      // percent (e.g. 4.2 = 4.2%)
  const computedCtrRatio = computedCtr / 100;     // ratio (e.g. 0.042)

  // Baseline collapse guard:
  //   (1) if warm avg CTR is zero (Analytics has not yet emitted real CTR
  //       rows for this channel), fall back to the bootstrap avg from
  //       ChannelGoal so we don't permanently neutralize the detector.
  //   (2) apply a MIN_CTR_THRESHOLD floor regardless, so the "below
  //       threshold" gate remains meaningful even as real averages drift.
  let ctrThreshold: number;
  let ctrSource: string;
  if (computedCtrRatio === 0 && bm) {
    ctrThreshold = Math.max(bm.avgCtr / 100, MIN_CTR_THRESHOLD);
    ctrSource = `warm avg=0, fell back to bootstrap avgCtr=${bm.avgCtr}% (floored at ${MIN_CTR_THRESHOLD * 100}%)`;
  } else {
    ctrThreshold = Math.max(computedCtrRatio, MIN_CTR_THRESHOLD);
    ctrSource =
      computedCtrRatio < MIN_CTR_THRESHOLD
        ? `warm avg ${computedCtr.toFixed(2)}% below floor, using ${MIN_CTR_THRESHOLD * 100}%`
        : `warm avg ${computedCtr.toFixed(2)}%`;
  }

  const result: Baseline = {
    ctrThreshold,
    viewsThreshold: WARM_VIEWS_THRESHOLD,
    goalText: goal?.goal ?? null,
    bootstrapBenchmarks: bm,
  };
  console.log(
    `[decisionEngine] Warm channel (${snapshotVideoCount.length} videos) — computed avgCtr: ${computedCtr.toFixed(2)}% (${ctrSource})`,
  );
  console.log(
    `[decisionEngine] Channel averages → ctrThreshold: ${(result.ctrThreshold * 100).toFixed(2)}%, viewsThreshold: ${result.viewsThreshold}`,
  );
  return result;
}

/**
 * Call Claude to evaluate video metrics and suggest actions.
 */
async function claudeEvaluate(
  metrics: VideoMetrics[],
  baseline: Baseline,
): Promise<Decision[]> {
  const config = env();
  const decisions: Decision[] = [];

  const metricsContext = metrics.map((m) => ({
    videoId: m.videoId,
    youtubeId: m.youtubeId,
    views: m.views,
    likes: m.likes,
    comments: m.comments,
    ctr: m.ctr !== undefined ? `${(m.ctr * 100).toFixed(2)}%` : "unknown",
    avgViewDuration: m.avgViewDuration ?? "unknown",
  }));

  // Fetch recent comments for comment-based actions (current channel only)
  const recentComments = await comments.findMany({
    where: { videoId: { in: metrics.map((m) => m.videoId) } },
    orderBy: { likeCount: "desc" },
    take: 20,
  });

  const commentsContext = recentComments.length > 0
    ? `\n\nRecent high-engagement comments:\n${JSON.stringify(
        recentComments.map((c: any) => ({
          videoId: c.videoId,
          commentId: c.youtubeCommentId,
          author: c.authorName,
          text: c.text.slice(0, 200),
          likes: c.likeCount,
          isPinned: c.isPinned,
        })),
        null,
        2,
      )}`
    : "";

  const prompt = `You are a YouTube channel monitor deciding whether to take action on videos.

Channel goal: ${baseline.goalText ?? "Not set"}
Channel averages: CTR threshold = ${(baseline.ctrThreshold * 100).toFixed(2)}%, views threshold = ${baseline.viewsThreshold}
${baseline.bootstrapBenchmarks ? `Bootstrap benchmarks: avgCtr=${baseline.bootstrapBenchmarks.avgCtr}%, avgViews48hr=${baseline.bootstrapBenchmarks.avgViews48hr}, avgViewDuration=${baseline.bootstrapBenchmarks.avgViewDuration}s, avgSubsPerVideo=${baseline.bootstrapBenchmarks.avgSubsPerVideo}` : ""}

Current video metrics:
${JSON.stringify(metricsContext, null, 2)}${commentsContext}

Available actions:
- UPDATE_TITLE: Video CTR is significantly below channel average and has enough impressions to be meaningful. Include a "newTitle" suggestion in payload. (Requires user approval.)
- REGENERATE_THUMBNAIL: ONLY when impressions > 100 AND CTR < 3%. Thumbnail is underperforming. (Requires user approval.)
- UPDATE_DESCRIPTION: Video description needs improvement for better engagement or SEO. Include "newDescription" with the full rewritten description in payload. (Requires user approval.)
- UPDATE_TAGS: ONLY when impressions > 100 AND CTR < 3%. Discovery seems poor. You MUST include a "tags" array in the payload with 10-15 specific tag strings. (Requires user approval.)
- PIN_COMMENT: A viewer comment deserves to be pinned (great question, useful summary, high engagement). Include "commentId" and "commentText" in payload. (Auto-sends alert.)
- REPLY_COMMENT: A comment warrants a thoughtful channel reply. Include "commentId", "commentText" (the original), and "replyText" (your drafted reply) in payload. Keep replies authentic and conversational. (Requires user approval.)
- NO_ACTION: Metrics look normal or there's not enough data to act.

HARD RULES:
- NEVER suggest REGENERATE_THUMBNAIL or UPDATE_TAGS unless impressions > 100 AND CTR < 3%
- NEVER suggest any action on videos with fewer than 10 views
- Do NOT use the ALERT action — it has been removed

You may suggest multiple actions per video if warranted (e.g. UPDATE_TAGS + REPLY_COMMENT).

Respond with ONLY a JSON array:
[{"videoId": "...", "action": "NO_ACTION|UPDATE_TITLE|REGENERATE_THUMBNAIL|UPDATE_DESCRIPTION|UPDATE_TAGS|PIN_COMMENT|REPLY_COMMENT", "reasoning": "...", "payload": {}}]

Payload requirements by action type:
- UPDATE_TITLE: payload MUST include {"newTitle": "..."}
- UPDATE_DESCRIPTION: payload MUST include {"newDescription": "full description text..."}
- UPDATE_TAGS: payload MUST include {"tags": ["tag1", "tag2", ...]} with 10-15 tags
- PIN_COMMENT: payload MUST include {"commentId": "...", "commentText": "..."}
- REPLY_COMMENT: payload MUST include {"commentId": "...", "commentText": "...", "replyText": "..."}
- All others: payload can be {}

Be specific in your reasoning — reference the actual numbers. Only suggest actions when there's a clear signal.`;

  console.log(`[decisionEngine] Calling Claude with ${metrics.length} videos, baselines: ctrThreshold=${(baseline.ctrThreshold * 100).toFixed(2)}%, viewsThreshold=${baseline.viewsThreshold}`);

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  console.log(`[decisionEngine] ── Claude response ──\n${responseText}\n── end Claude response ──`);

  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found in response");

    const parsed: { videoId: string; action: string; reasoning: string; payload?: Record<string, unknown> }[] =
      JSON.parse(jsonMatch[0]);

    for (const cd of parsed) {
      console.log(
        `[decisionEngine] Claude decision: video=${cd.videoId} action=${cd.action} reasoning="${cd.reasoning}"`,
      );

      if (cd.action === "NO_ACTION") continue;

      if (!(cd.action in ActionType)) {
        console.warn(`[decisionEngine] Unknown action type from Claude: ${cd.action}`);
        continue;
      }

      // Validate videoId exists in DB — Claude sometimes hallucinates IDs
      const videoExists = await videos.findUnique({ where: { id: cd.videoId }, select: { id: true } });
      if (!videoExists) {
        console.warn(`[decisionEngine] Skipping ${cd.action} — videoId ${cd.videoId} not found in DB`);
        continue;
      }

      // Dedup: ALERTs are allowed once per video per 24h; other types blocked if pending/executed/awaiting
      const isAlert = cd.action === ActionType.ALERT;
      const existing = await actions.findFirst({
        where: {
          videoId: cd.videoId,
          type: cd.action as ActionType,
          ...(isAlert
            ? { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
            : { status: { in: ["PENDING", "EXECUTED", "AWAITING_APPROVAL"] } }),
        },
      });
      if (existing) {
        console.log(`[decisionEngine] Skipping ${cd.action} for ${cd.videoId} — ${isAlert ? "already alerted in last 24h" : `already exists (${existing.status})`}`);
        continue;
      }

      decisions.push({
        videoId: cd.videoId,
        type: cd.action as ActionType,
        payload: cd.payload ?? {},
        reason: cd.reasoning,
      });
    }
  } catch (err) {
    console.error(
      `[decisionEngine] Failed to parse Claude response: ${err instanceof Error ? err.message : err}`,
    );
  }

  return decisions;
}

/**
 * Analyze current metrics and recent comments, return suggested actions.
 */
export async function evaluate(
  metrics: VideoMetrics[],
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  const baseline = await getBaseline();

  // ── Claude-based evaluation ─────────────────────────────────────────
  if (metrics.length > 0) {
    try {
      const claudeDecisions = await claudeEvaluate(metrics, baseline);
      decisions.push(...claudeDecisions);
    } catch (err) {
      console.error(
        `[decisionEngine] Claude evaluation failed, falling back to rules: ${err instanceof Error ? err.message : err}`,
      );
      // Fallback: rule-based CTR check
      for (const m of metrics) {
        if (m.ctr !== undefined && m.ctr < baseline.ctrThreshold && m.views > baseline.viewsThreshold) {
          const existing = await actions.findFirst({
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
      }
    }
  }

  // ── Rule-based: heart high-engagement comments ──────────────────────
  for (const m of metrics) {
    // Skip videos with < 10 views — not enough data to act on
    if (m.views < 10) continue;

    const unhearted = await comments.findMany({
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

    // NOTE: Standalone ALERT messages removed — bot only sends approval
    // requests, action confirmations, and daily digest (no toothless alerts)
  }

  console.log(`[decisionEngine] Generated ${decisions.length} total decisions`);
  return decisions;
}
