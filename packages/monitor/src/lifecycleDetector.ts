import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./lib/prisma";
import { env } from "./config";
import { ActionType } from "./lib/types";
import type { Decision } from "./lib/types";

const REPROMO_WINDOW_MS = 48 * 60 * 60 * 1000;

async function callClaude(prompt: string): Promise<string> {
  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

async function hasExistingAction(videoId: string, type: string): Promise<boolean> {
  const existing = await prisma.monitorAction.findFirst({
    where: {
      videoId,
      type: type as any,
      status: { in: ["PENDING", "EXECUTED", "AWAITING_APPROVAL"] },
    },
  });
  return !!existing;
}

/**
 * Detect lifecycle events: community post after publish, end screen
 * suggestions, and re-promotion of underperformers.
 */
export async function detectLifecycleEvents(): Promise<Decision[]> {
  const decisions: Decision[] = [];
  const now = new Date();

  // Find published videos (scheduledAt in the past, has youtubeId)
  const publishedVideos = await prisma.video.findMany({
    where: {
      youtubeId: { not: null },
      scheduledAt: { lte: now },
    },
    include: { topic: true },
  });

  if (publishedVideos.length === 0) return decisions;

  // ── Community post + end screen for newly published videos ──────────
  for (const video of publishedVideos) {
    // Community post
    if (!await hasExistingAction(video.id, ActionType.COMMUNITY_POST)) {
      try {
        const draft = await callClaude(
          `Draft a short YouTube Community post (2-3 sentences) to promote this newly published video. Include relevant emoji. End with a question to drive engagement.

Video title: "${video.seoTitle ?? video.topic.title}"
Topic: ${video.topic.summary ?? video.topic.title}
Link: https://youtu.be/${video.youtubeId}

Return ONLY the community post text, nothing else.`,
        );

        if (draft.trim()) {
          decisions.push({
            videoId: video.id,
            type: ActionType.COMMUNITY_POST,
            payload: { draftText: draft.trim(), youtubeId: video.youtubeId },
            reason: "Video published — draft community post for promotion",
          });
        }
      } catch (err) {
        console.error(`[lifecycle] Community post draft failed for ${video.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // End screen suggestion
    if (!await hasExistingAction(video.id, ActionType.END_SCREEN)) {
      // Find other published videos to recommend
      const otherVideos = publishedVideos.filter((v: any) => v.id !== video.id && v.youtubeId);
      if (otherVideos.length > 0) {
        try {
          const videoList = otherVideos
            .map((v: any) => `- "${v.seoTitle ?? v.topic.title}" (https://youtu.be/${v.youtubeId})`)
            .join("\n");

          const suggestion = await callClaude(
            `Pick the most relevant video to link as an end screen for this video. Consider topic overlap and audience interest.

Current video: "${video.seoTitle ?? video.topic.title}"
Topic: ${video.topic.summary ?? video.topic.title}

Other videos on the channel:
${videoList}

Respond with ONLY a JSON object: {"youtubeId": "...", "title": "...", "reasoning": "..."}`,
          );

          let parsed: { youtubeId?: string; title?: string; reasoning?: string } = {};
          try {
            let raw = suggestion.trim();
            if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
            parsed = JSON.parse(raw);
          } catch { /* ignore parse errors */ }

          if (parsed.youtubeId) {
            decisions.push({
              videoId: video.id,
              type: ActionType.END_SCREEN,
              payload: {
                suggestedYoutubeId: parsed.youtubeId,
                suggestedTitle: parsed.title ?? "",
                reasoning: parsed.reasoning ?? "",
              },
              reason: "End screen suggestion for published video",
            });
          }
        } catch (err) {
          console.error(`[lifecycle] End screen suggestion failed for ${video.id}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // ── Re-promotion: published > 48hrs, views below channel average ────
  const cutoff = new Date(Date.now() - REPROMO_WINDOW_MS);
  const matureVideos = publishedVideos.filter(
    (v: any) => v.scheduledAt && v.scheduledAt <= cutoff,
  );

  if (matureVideos.length > 1) {
    // Get latest snapshot for each
    const viewsMap = new Map<string, number>();
    for (const v of matureVideos) {
      const snap = await prisma.videoSnapshot.findFirst({
        where: { videoId: v.id },
        orderBy: { createdAt: "desc" },
      });
      if (snap) viewsMap.set(v.id, snap.views);
    }

    const allViews = [...viewsMap.values()];
    const avgViews = allViews.reduce((a, b) => a + b, 0) / allViews.length;

    for (const video of matureVideos) {
      const views = viewsMap.get(video.id) ?? 0;
      if (views >= avgViews) continue; // performing fine

      // Gate: only re-promote if views > 50 AND avgViewDuration > 40s
      if (views <= 50) continue;
      const latestSnap = await prisma.videoSnapshot.findFirst({
        where: { videoId: video.id },
        orderBy: { createdAt: "desc" },
      });
      if (!latestSnap?.avgViewDuration || latestSnap.avgViewDuration <= 40) continue;

      if (await hasExistingAction(video.id, ActionType.REPROMOTE)) continue;

      try {
        const draft = await callClaude(
          `Draft a short YouTube Community post (2-3 sentences) to re-promote an underperforming video. Make it feel fresh, not desperate. Include emoji and a hook question.

Video title: "${video.seoTitle ?? video.topic.title}"
Current views: ${views} (channel average: ${Math.round(avgViews)})
Link: https://youtu.be/${video.youtubeId}

Return ONLY the community post text, nothing else.`,
        );

        if (draft.trim()) {
          decisions.push({
            videoId: video.id,
            type: ActionType.REPROMOTE,
            payload: { draftText: draft.trim(), youtubeId: video.youtubeId, views, avgViews },
            reason: `${views} views after 48hrs (channel avg: ${Math.round(avgViews)}) — re-promote`,
          });
        }
      } catch (err) {
        console.error(`[lifecycle] Re-promotion draft failed for ${video.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`[lifecycle] Generated ${decisions.length} lifecycle decisions`);
  return decisions;
}
