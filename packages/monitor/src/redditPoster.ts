import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./lib/prisma";
import { env } from "./config";
import { ActionType } from "./lib/types";
import type { Decision } from "./lib/types";

const SUBREDDIT_MAP: Record<string, string[]> = {
  ai: ["artificial", "ChatGPT"],
  llm: ["artificial", "MachineLearning"],
  openai: ["ChatGPT", "artificial"],
  anthropic: ["artificial", "MachineLearning"],
  google: ["artificial", "ChatGPT"],
  model: ["MachineLearning", "artificial"],
  agent: ["artificial", "ChatGPT"],
  default: ["artificial"],
};

/**
 * Pick the best subreddit based on topic keywords.
 */
function pickSubreddit(title: string, summary: string): string {
  const text = `${title} ${summary}`.toLowerCase();
  for (const [keyword, subs] of Object.entries(SUBREDDIT_MAP)) {
    if (keyword !== "default" && text.includes(keyword)) {
      return subs[0];
    }
  }
  return "artificial";
}

/**
 * Check for newly published videos that need Reddit posts.
 * Returns Decision[] for approval via Telegram.
 */
export async function generateRedditPosts(): Promise<Decision[]> {
  const config = env();
  if (!config.REDDIT_CLIENT_ID) {
    console.log("[redditPoster] Reddit not configured, skipping");
    return [];
  }

  const decisions: Decision[] = [];

  // Find published videos that don't have a RedditPost yet
  const publishedVideos = await prisma.video.findMany({
    where: {
      youtubeId: { not: null },
      scheduledAt: { lte: new Date() },
    },
    include: { topic: true },
  });

  for (const video of publishedVideos) {
    // Check if RedditPost already exists for this video
    const existing = await prisma.redditPost.findFirst({
      where: { videoId: video.id },
    });
    if (existing) continue;

    // Also check MonitorAction dedup
    const existingAction = await prisma.monitorAction.findFirst({
      where: {
        videoId: video.id,
        type: "REDDIT_POST",
        status: { in: ["PENDING", "EXECUTED", "AWAITING_APPROVAL"] },
      },
    });
    if (existingAction) continue;

    const subreddit = pickSubreddit(
      video.seoTitle ?? video.topic.title,
      video.topic.summary ?? "",
    );

    // Use Claude to draft a native-feeling Reddit post
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: `Write a Reddit post for r/${subreddit} sharing this YouTube video.

The post should read like a real person sharing something interesting they found — NOT promotional. No "check out my video" energy. Write it like you're a community member who genuinely found this interesting.

Video title: "${video.seoTitle ?? video.topic.title}"
Topic summary: ${video.topic.summary ?? video.topic.title}
YouTube URL: https://youtu.be/${video.youtubeId}

Rules:
- Title should be interesting/provocative on its own (don't mention YouTube)
- Body should be 2-4 sentences of genuine commentary or context
- Put the YouTube link at the very end naturally
- Match the tone of r/${subreddit}

Respond with ONLY JSON: {"title": "...", "body": "..."}`,
        }],
      });

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      let parsed: { title: string; body: string };
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON");
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn(`[redditPoster] Failed to parse Claude response for ${video.id}`);
        continue;
      }

      // Save draft to DB
      await prisma.redditPost.create({
        data: {
          videoId: video.id,
          subreddit,
          title: parsed.title,
          body: parsed.body,
          status: "DRAFT",
        },
      });

      decisions.push({
        videoId: video.id,
        type: ActionType.REDDIT_POST,
        payload: {
          subreddit,
          postTitle: parsed.title,
          postBody: parsed.body,
          youtubeUrl: `https://youtu.be/${video.youtubeId}`,
        },
        reason: `Draft Reddit post for r/${subreddit}`,
      });

      console.log(`[redditPoster] Drafted post for ${video.id} → r/${subreddit}`);
    } catch (err) {
      console.error(`[redditPoster] Failed to draft for ${video.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return decisions;
}

/**
 * Post an approved Reddit draft using snoowrap.
 */
export async function submitRedditPost(videoId: string): Promise<{ success: boolean; message: string }> {
  const config = env();
  if (!config.REDDIT_CLIENT_ID || !config.REDDIT_CLIENT_SECRET || !config.REDDIT_USERNAME || !config.REDDIT_PASSWORD) {
    return { success: false, message: "Reddit credentials not configured" };
  }

  const draft = await prisma.redditPost.findFirst({
    where: { videoId, status: "DRAFT" },
    orderBy: { createdAt: "desc" },
  });

  if (!draft) {
    return { success: false, message: "No draft Reddit post found" };
  }

  try {
    const Snoowrap = (await import("snoowrap")).default;
    const reddit = new Snoowrap({
      userAgent: config.REDDIT_USER_AGENT ?? "yt-pipeline-bot/1.0",
      clientId: config.REDDIT_CLIENT_ID,
      clientSecret: config.REDDIT_CLIENT_SECRET,
      username: config.REDDIT_USERNAME,
      password: config.REDDIT_PASSWORD,
    });

    const submission = await (reddit.submitSelfpost as any)({
      subredditName: draft.subreddit,
      title: draft.title,
      text: draft.body,
    });

    const redditUrl = `https://www.reddit.com${submission.permalink}`;
    const redditPostId = submission.name;

    await prisma.redditPost.update({
      where: { id: draft.id },
      data: {
        status: "POSTED",
        redditPostId,
        redditUrl,
        postedAt: new Date(),
      },
    });

    console.log(`[redditPoster] Posted to r/${draft.subreddit}: ${redditUrl}`);
    return { success: true, message: `Posted to r/${draft.subreddit}: ${redditUrl}` };
  } catch (err) {
    await prisma.redditPost.update({
      where: { id: draft.id },
      data: { status: "FAILED" },
    });

    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[redditPoster] Submit failed: ${msg}`);
    return { success: false, message: msg };
  }
}
