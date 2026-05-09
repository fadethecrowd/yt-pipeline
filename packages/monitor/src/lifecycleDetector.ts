import Anthropic from "@anthropic-ai/sdk";
import { videos, snapshots, actions } from "./lib/channelDb";
import { env } from "./config";
import { acquireAICall } from "./lib/aiCallBudget";
import { ActionType } from "./lib/types";
import { liveVideoWhere } from "./lib/queries";
import { MODEL_REASONING } from "./lib/models";
import type { Decision } from "./lib/types";

const REPROMO_WINDOW_MS = 48 * 60 * 60 * 1000;

async function callClaude(prompt: string): Promise<string> {
  if (!acquireAICall("lifecycleDetector")) return "";
  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  console.log(`[lifecycle] Anthropic call: model=${MODEL_REASONING}`);
  const message = await anthropic.messages.create({
    model: MODEL_REASONING,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

async function hasExistingAction(videoId: string, type: string): Promise<boolean> {
  const existing = await actions.findFirst({
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

  // Find published videos. `scheduledAt <= now` catches post-launch uploads
  // that were given a publish slot; `scheduledAt = null` catches pre-launch
  // WC uploads that went to YouTube as PRIVATE with no schedule and were
  // later flipped to public on Studio — the DB has no record of that
  // transition, so null here means "published without a schedule in our
  // DB", not "not yet scheduled". Both cases are accessible on YouTube.
  const rawPublished = await videos.findMany({
    where: {
      ...liveVideoWhere,
      OR: [
        { scheduledAt: { lte: now } },
        { scheduledAt: null },
      ],
    },
    include: { topic: true },
  });

  // Defensive filter: skip rows explicitly marked as orphaned (i.e. the
  // youtubeId was cleared OR the video is known-deleted). liveVideoWhere
  // already excludes null youtubeIds, but the `[orphan]` tag can also
  // appear on rows that retain a non-null stale ID we shouldn't draft
  // lifecycle actions for. Filter in JS rather than Prisma because
  // `NOT: { failReason: { startsWith: ... } }` excludes rows with NULL
  // failReason (SQL three-valued logic on NOT LIKE null) — we want those
  // rows INCLUDED.
  const liveVideos = rawPublished.filter(
    (v: any) => !(v.failReason ?? "").startsWith("[orphan]"),
  );

  // Skip Shorts. COMMUNITY_POST / END_SCREEN / REPROMOTE are long-form
  // lifecycle artifacts; community posts on a Short look spammy and
  // end-screen suggestions don't apply (Shorts have no end-screen UI).
  // Source the isShort flag from each video's latest VideoSnapshot —
  // single batch query, descending order, first hit per videoId wins.
  // Videos with no snapshot yet default to LONG (defensive — same as
  // /status's split logic).
  let publishedVideos = liveVideos;
  if (liveVideos.length > 0) {
    const ids = liveVideos.map((v: any) => v.id);
    const snaps = await snapshots.findMany({
      where: { videoId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { videoId: true, isShort: true },
    });
    const isShortByVideo = new Map<string, boolean>();
    for (const s of snaps) {
      if (!isShortByVideo.has(s.videoId)) isShortByVideo.set(s.videoId, s.isShort);
    }
    const filtered: typeof liveVideos = [];
    for (const v of liveVideos) {
      const isShort = isShortByVideo.get(v.id) ?? false;
      if (isShort) {
        console.log(
          `[lifecycle] Skipping Shorts video ${v.id} yt=${v.youtubeId ?? "(null)"} — long-form-only lifecycle actions don't apply`,
        );
        continue;
      }
      filtered.push(v);
    }
    publishedVideos = filtered;
  }

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
  // For pre-launch WC videos with scheduledAt=null, fall back to createdAt
  // as the publish reference — they were uploaded before a schedule ever
  // existed and are definitely older than 48h by now.
  const cutoff = new Date(Date.now() - REPROMO_WINDOW_MS);
  const matureVideos = publishedVideos.filter((v: any) => {
    const publishTime: Date | null = v.scheduledAt ?? v.createdAt ?? null;
    return publishTime !== null && publishTime <= cutoff;
  });

  if (matureVideos.length > 1) {
    // Get latest snapshot for each
    const viewsMap = new Map<string, number>();
    for (const v of matureVideos) {
      const snap = await snapshots.findFirst({
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
      const latestSnap = await snapshots.findFirst({
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
