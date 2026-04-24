import Anthropic from "@anthropic-ai/sdk";
import { goal as goalDb, topicSeeds } from "./lib/channelDb";
import { getChannelConfig } from "./lib/channelConfig";
import { env } from "./config";
import { MODEL_LIGHTWEIGHT } from "./lib/models";

const USER_AGENT = "yt-pipeline-monitor/0.1.0";

interface RedditPost {
  title: string;
  subreddit: string;
  score: number;
  topComments: string[];
}

/**
 * Fetch top daily posts from a subreddit.
 */
async function fetchSubreddit(subreddit: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?limit=25&t=day`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) {
    console.warn(`[redditScraper] Failed to fetch r/${subreddit}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as any;
  const posts: RedditPost[] = [];

  for (const child of data?.data?.children ?? []) {
    const post = child.data;
    posts.push({
      title: post.title ?? "",
      subreddit,
      score: post.score ?? 0,
      topComments: [],
    });
  }

  return posts;
}

/**
 * Fetch top comments for a post (lightweight — just titles + top few comments).
 */
async function fetchTopComments(subreddit: string, postId: string): Promise<string[]> {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=5&depth=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as any[];
    const comments: string[] = [];
    for (const child of data?.[1]?.data?.children ?? []) {
      const body = child?.data?.body;
      if (body && typeof body === "string") {
        comments.push(body.slice(0, 300));
      }
    }
    return comments;
  } catch {
    return [];
  }
}

/**
 * Scrape Reddit and use Claude to extract video topic candidates.
 * Writes results to the TopicSeed table.
 */
export async function scrapeRedditTopics(): Promise<void> {
  const config = env();
  const channelConfig = getChannelConfig();

  // 1. Fetch posts from all subreddits configured for this channel
  const allPosts: RedditPost[] = [];
  for (const sub of channelConfig.scrapeSubreddits) {
    const posts = await fetchSubreddit(sub);
    allPosts.push(...posts);
  }

  if (allPosts.length === 0) {
    console.log("[redditScraper] No posts fetched");
    return;
  }

  // Sort by score, take top 30
  allPosts.sort((a, b) => b.score - a.score);
  const topPosts = allPosts.slice(0, 30);

  console.log(`[redditScraper] Fetched ${allPosts.length} posts, using top ${topPosts.length}`);

  // 2. Get channel goal for context (current channel only)
  const goal = await goalDb.find();
  const goalText = goal?.goal ?? channelConfig.contentDescription;

  // 3. Build prompt with post data
  const postSummary = topPosts
    .map((p, i) => `${i + 1}. [r/${p.subreddit}] (score: ${p.score}) ${p.title}`)
    .join("\n");

  const prompt = `You are a YouTube content strategist.

Channel content domain: ${channelConfig.contentDescription}
Channel goal: ${goalText}

Below are today's top Reddit posts from subreddits relevant to this channel:

${postSummary}

Based on these trending topics, suggest exactly 5 video topic candidates that would:
- Be timely and relevant to the channel goal
- Have broad appeal for a YouTube audience (not too niche)
- Work well as 5-10 minute explainer/news videos

Respond with ONLY a JSON array of 5 objects, each with "title" and "rationale" fields.
Example: [{"title": "...", "rationale": "..."}]`;

  // 4. Call Claude
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  console.log(`[redditScraper] Anthropic call: model=${MODEL_LIGHTWEIGHT}`);
  const message = await anthropic.messages.create({
    model: MODEL_LIGHTWEIGHT,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 5. Parse response
  let candidates: { title: string; rationale: string }[];
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    candidates = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("[redditScraper] Failed to parse Claude response:", err instanceof Error ? err.message : err);
    return;
  }

  // 6. Write to TopicSeed table (current channel only)
  let inserted = 0;
  const source = `reddit:${channelConfig.scrapeSubreddits.map((s) => `r/${s}`).join("+")}`;
  for (const c of candidates) {
    if (!c.title) continue;
    await topicSeeds.create({
      data: {
        title: c.title,
        rationale: c.rationale ?? "",
        source,
      },
    });
    inserted++;
  }

  console.log(`[redditScraper] Inserted ${inserted} topic seeds`);
}
