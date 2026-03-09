import Parser from "rss-parser";
import { TopicStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { FeedItem, PipelineContext, StageResult } from "../types";

// RSS feed sources for AI/tech news
const FEEDS: Record<string, string> = {
  techcrunch: "https://techcrunch.com/category/artificial-intelligence/feed/",
  ars_technica: "https://feeds.arstechnica.com/arstechnica/technology-lab",
  hackernews: "https://hnrss.org/best?q=AI+OR+LLM+OR+GPT+OR+machine+learning",
  venturebeat: "https://venturebeat.com/category/ai/feed/",
};

// Keywords to score relevance against
const KEYWORDS = [
  "ai",
  "llm",
  "model",
  "automation",
  "tool",
  "agent",
  "openai",
  "anthropic",
  "google",
  "startup",
];

const parser = new Parser();

/**
 * Stage 1: Poll RSS feeds for AI/tech topics.
 * Stores new topics in the DB, returns the highest-scored DISCOVERED topic.
 */
export async function topicDiscovery(
  _ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  // 1. Fetch all RSS feeds
  const items = await fetchFeeds();
  console.log(`[topicDiscovery] Fetched ${items.length} items from ${Object.keys(FEEDS).length} feeds`);

  // 2. Deduplicate against existing topics by URL
  const existingUrls = new Set(
    (
      await prisma.topic.findMany({
        where: { url: { in: items.map((i) => i.url) } },
        select: { url: true },
      })
    ).map((t) => t.url)
  );

  const newItems = items.filter((i) => !existingUrls.has(i.url));
  console.log(`[topicDiscovery] ${newItems.length} new items after dedup`);

  // 3. Score and insert new topics
  if (newItems.length > 0) {
    const scored = newItems.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      summary: item.summary ?? null,
      score: scoreTopic(item),
      status: "DISCOVERED" as const,
    }));

    // Use skipDuplicates in case of race conditions on the unique url constraint
    await prisma.topic.createMany({
      data: scored,
      skipDuplicates: true,
    });
    console.log(`[topicDiscovery] Inserted ${scored.length} topics`);
  }

  // 4. Pick the best un-used topic
  const topic = await prisma.topic.findFirst({
    where: { status: TopicStatus.DISCOVERED },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
  });

  if (!topic) {
    return { success: false, error: "No viable topics", durationMs: Date.now() - start };
  }

  // Mark it as approved so it won't be picked again
  await prisma.topic.update({
    where: { id: topic.id },
    data: { status: TopicStatus.APPROVED },
  });

  return { success: true, data: topic, durationMs: Date.now() - start };
}

/** Fetch and normalize items from all configured RSS feeds. */
async function fetchFeeds(): Promise<FeedItem[]> {
  const results: FeedItem[] = [];

  const settled = await Promise.allSettled(
    Object.entries(FEEDS).map(async ([source, url]) => {
      try {
        const feed = await parser.parseURL(url);
        return (feed.items ?? []).map((item): FeedItem | null => {
          const link = item.link?.trim();
          if (!link) return null;
          return {
            title: (item.title ?? "").trim(),
            url: link,
            source,
            summary: (item.contentSnippet ?? item.content ?? "").slice(0, 500).trim() || undefined,
            publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
          };
        });
      } catch (err) {
        console.warn(`[topicDiscovery] Failed to fetch ${source}: ${err}`);
        return [];
      }
    })
  );

  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      for (const item of result.value) {
        if (item) results.push(item);
      }
    }
  }

  return results;
}

/**
 * Score a topic 0–1 based on:
 *   - Keyword relevance (0–0.6): how many AI/tech keywords appear in title + summary
 *   - Recency (0–0.4): exponential decay, half-life of 24 hours
 */
function scoreTopic(item: FeedItem): number {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();

  // Keyword score: fraction of keywords found, weighted to 0.6
  const hits = KEYWORDS.filter((kw) => text.includes(kw)).length;
  const keywordScore = (hits / KEYWORDS.length) * 0.6;

  // Recency score: exponential decay with 24h half-life, weighted to 0.4
  let recencyScore = 0.4; // default to full if no date
  if (item.publishedAt) {
    const ageHours = (Date.now() - item.publishedAt.getTime()) / (1000 * 60 * 60);
    const halfLife = 24;
    recencyScore = Math.pow(0.5, ageHours / halfLife) * 0.4;
  }

  return Math.round((keywordScore + recencyScore) * 1000) / 1000;
}
