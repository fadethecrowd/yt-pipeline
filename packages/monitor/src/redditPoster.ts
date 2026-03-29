import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./lib/prisma";
import { env } from "./config";
import { ActionType } from "./lib/types";
import type { Decision } from "./lib/types";
import { sendTelegram } from "./telegram";

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
  const redditConfigured = !!(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET && config.REDDIT_USERNAME && config.REDDIT_PASSWORD);

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

      if (redditConfigured) {
        // Reddit credentials available — route through approval flow for auto-posting
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
      } else {
        // No Reddit credentials — send draft to Telegram for manual posting
        const telegramMsg = [
          `*Reddit Draft* — r/${subreddit}`,
          "",
          `*${parsed.title}*`,
          "",
          parsed.body,
          "",
          `⚠️ Reddit auto-posting not active — copy and paste this manually to Reddit`,
        ].join("\n");

        try {
          await sendTelegram(telegramMsg);
        } catch {
          // Non-fatal
        }
      }

      console.log(`[redditPoster] Drafted post for ${video.id} → r/${subreddit}${redditConfigured ? "" : " (sent to Telegram for manual posting)"}`);
    } catch (err) {
      console.error(`[redditPoster] Failed to draft for ${video.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return decisions;
}

/**
 * Post an approved Reddit draft using snoowrap.
 */
/**
 * Send a Reddit draft to Telegram for manual copy-paste.
 */
async function sendDraftToTelegram(draft: { subreddit: string; title: string; body: string }, reason: string): Promise<void> {
  const msg = [
    `*Reddit Draft* — r/${draft.subreddit}`,
    "",
    `*${draft.title}*`,
    "",
    draft.body,
    "",
    `⚠️ ${reason} — copy and paste this manually to Reddit`,
  ].join("\n");

  try {
    await sendTelegram(msg);
  } catch {
    // Non-fatal
  }
}

/**
 * Post an approved Reddit draft using snoowrap.
 * Falls back to Telegram delivery if credentials are missing or posting fails.
 */
export async function submitRedditPost(videoId: string): Promise<{ success: boolean; message: string }> {
  const config = env();

  const draft = await prisma.redditPost.findFirst({
    where: { videoId, status: "DRAFT" },
    orderBy: { createdAt: "desc" },
  });

  if (!draft) {
    return { success: false, message: "No draft Reddit post found" };
  }

  if (!config.REDDIT_CLIENT_ID || !config.REDDIT_CLIENT_SECRET || !config.REDDIT_USERNAME || !config.REDDIT_PASSWORD) {
    await sendDraftToTelegram(draft, "Reddit auto-posting not active");
    return { success: true, message: "Reddit not configured — draft sent to Telegram for manual posting" };
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[redditPoster] Submit failed: ${msg}`);

    // Auth rejection or other failure — send to Telegram as fallback
    await sendDraftToTelegram(draft, `Reddit posting failed (${msg.slice(0, 60)})`);

    await prisma.redditPost.update({
      where: { id: draft.id },
      data: { status: "FAILED" },
    });

    return { success: true, message: `Reddit post failed — draft sent to Telegram for manual posting` };
  }
}
