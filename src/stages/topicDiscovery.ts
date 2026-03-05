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

/**
 * Stage 1: Poll RSS feeds and YouTube trending for AI/tech topics.
 * Stores new topics in the DB, returns the highest-scored DISCOVERED topic.
 */
export async function topicDiscovery(
  _ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  // TODO: Parse RSS feeds using rss-parser
  const _items: FeedItem[] = await fetchFeeds();

  // TODO: Deduplicate against existing topics by URL
  // TODO: Score topics for relevance (recency, keyword density, etc.)
  // TODO: Upsert into DB

  // Pick the best un-used topic
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
  // TODO: Implement with rss-parser
  // const parser = new RSSParser();
  // for (const [source, url] of Object.entries(FEEDS)) { ... }
  console.log("[topicDiscovery] TODO: fetch RSS feeds from", Object.keys(FEEDS));
  return [];
}
