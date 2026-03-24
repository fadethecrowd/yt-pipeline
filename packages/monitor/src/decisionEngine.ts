import Anthropic from "@anthropic-ai/sdk";
import { ActionType } from "./lib/types";
import { prisma } from "./lib/prisma";
import { env } from "./config";
import type { BootstrapBenchmarks, Decision, VideoMetrics } from "./lib/types";

const COLD_START_THRESHOLD = 15; // videos needed before using real averages
const HIGH_LIKE_COMMENT = 3; // heart comments with 3+ likes

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
  // ── 1. ChannelGoal lookup ───────────────────────────────────────────
  const goal = await prisma.channelGoal.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (goal) {
    console.log(`[decisionEngine] ChannelGoal FOUND (id=${goal.id}, goal="${goal.goal}")`);
  } else {
    console.log(`[decisionEngine] ChannelGoal NOT FOUND — no goal set in DB`);
  }

  let bm: BootstrapBenchmarks | null = null;
  if (goal?.bootstrapBenchmarks) {
    bm = goal.bootstrapBenchmarks as unknown as BootstrapBenchmarks;
    console.log(
      `[decisionEngine]   bootstrapBenchmarks: avgCtr=${bm.avgCtr}%, avgViews48hr=${bm.avgViews48hr}, avgViewDuration=${bm.avgViewDuration}s, avgSubsPerVideo=${bm.avgSubsPerVideo}`,
    );
  }

  // ── 2. Count unique videos with snapshots ───────────────────────────
  const snapshotVideoCount = await prisma.videoSnapshot.groupBy({
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

  // Warm channel — compute from actual snapshots
  const avgCtr = await prisma.videoSnapshot.aggregate({
    _avg: { ctr: true },
    where: { ctr: { not: null } },
  });

  const computedCtr = avgCtr._avg.ctr ?? 3;
  const result: Baseline = {
    ctrThreshold: computedCtr / 100,
    viewsThreshold: 100,
    goalText: goal?.goal ?? null,
    bootstrapBenchmarks: bm,
  };
  console.log(
    `[decisionEngine] Warm channel (${snapshotVideoCount.length} videos) — computed avgCtr: ${computedCtr.toFixed(2)}%`,
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

  // Fetch recent comments for comment-based actions
  const recentComments = await prisma.comment.findMany({
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
- REGENERATE_THUMBNAIL: Thumbnail appears to be underperforming based on low CTR despite good content signals. (Requires user approval.)
- UPDATE_DESCRIPTION: Video description needs improvement for better engagement or SEO. Include "newDescription" with the full rewritten description in payload. (Requires user approval.)
- UPDATE_TAGS: Video discovery seems poor relative to its quality. You MUST include a "tags" array in the payload with 10-15 specific tag strings. (Requires user approval.)
- PIN_COMMENT: A viewer comment deserves to be pinned (great question, useful summary, high engagement). Include "commentId" and "commentText" in payload. (Auto-sends alert.)
- REPLY_COMMENT: A comment warrants a thoughtful channel reply. Include "commentId", "commentText" (the original), and "replyText" (your drafted reply) in payload. Keep replies authentic and conversational. (Requires user approval.)
- ALERT: Anomalous performance worth flagging.
- NO_ACTION: Metrics look normal or there's not enough data to act.

You may suggest multiple actions per video if warranted (e.g. UPDATE_TAGS + REPLY_COMMENT).

Respond with ONLY a JSON array:
[{"videoId": "...", "action": "NO_ACTION|UPDATE_TITLE|REGENERATE_THUMBNAIL|UPDATE_DESCRIPTION|UPDATE_TAGS|PIN_COMMENT|REPLY_COMMENT|ALERT", "reasoning": "...", "payload": {}}]

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
    model: "claude-sonnet-4-20250514",
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
      const videoExists = await prisma.video.findUnique({ where: { id: cd.videoId }, select: { id: true } });
      if (!videoExists) {
        console.warn(`[decisionEngine] Skipping ${cd.action} — videoId ${cd.videoId} not found in DB`);
        continue;
      }

      // Dedup: ALERTs are allowed once per video per 24h; other types blocked if pending/executed/awaiting
      const isAlert = cd.action === ActionType.ALERT;
      const existing = await prisma.monitorAction.findFirst({
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
      }
    }
  }

  // ── Rule-based: heart high-engagement comments ──────────────────────
  for (const m of metrics) {
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

    // ── Alert on rapid view growth ──────────────────────────────────
    const snapshots = await prisma.videoSnapshot.findMany({
      where: { videoId: m.videoId },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    if (snapshots.length === 2) {
      const viewDelta = snapshots[0].views - snapshots[1].views;
      if (viewDelta > 1000) {
        // Allow one ALERT per video per 24 hours
        const recentAlert = await prisma.monitorAction.findFirst({
          where: {
            videoId: m.videoId,
            type: ActionType.ALERT,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });
        if (!recentAlert) {
          decisions.push({
            videoId: m.videoId,
            type: ActionType.ALERT,
            payload: { viewDelta, currentViews: m.views },
            reason: `Rapid growth: +${viewDelta} views since last poll`,
          });
        }
      }
    }
  }

  console.log(`[decisionEngine] Generated ${decisions.length} total decisions`);
  return decisions;
}
