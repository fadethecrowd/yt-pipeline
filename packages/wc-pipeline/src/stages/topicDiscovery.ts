import Parser from "rss-parser";
import { TopicStatus } from "@prisma/client";
import { prisma } from "@yt-pipeline/pipeline-core";
import type { FeedItem, PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// RSS feed sources for marine electronics / boating tech
const FEEDS: Record<string, string> = {
  // TODO: replace with actual marine electronics RSS feeds
  panbo: "https://panbo.com/feed/",
  passagemaker: "https://www.passagemaker.com/feed",
};

// Keywords to score relevance against
const KEYWORDS = [
  "marine",
  "electronics",
  "radar",
  "chartplotter",
  "sonar",
  "nmea",
  "garmin",
  "raymarine",
  "simrad",
  "furuno",
  "autopilot",
  "vhf",
  "ais",
  "gps",
  "boat",
];

const parser = new Parser();

/**
 * Stage 1: Poll RSS feeds for marine electronics topics.
 * Stores new topics in the DB, returns the highest-scored DISCOVERED topic.
 *
 * TODO: Implement full topic discovery for Wet Circuit channel.
 * This is a placeholder mirroring yt-pipeline's structure.
 */
export async function topicDiscovery(
  _ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  const items = await fetchFeeds();
  console.log(`[wc:topicDiscovery] Fetched ${items.length} items from ${Object.keys(FEEDS).length} feeds`);

  const existingUrls = new Set(
    (
      await prisma.wcTopic.findMany({
        where: { url: { in: items.map((i) => i.url) } },
        select: { url: true },
      })
    ).map((t) => t.url)
  );

  const newItems = items.filter((i) => !existingUrls.has(i.url));
  console.log(`[wc:topicDiscovery] ${newItems.length} new items after dedup`);

  if (newItems.length > 0) {
    const scored = newItems.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      summary: item.summary ?? null,
      score: scoreTopic(item),
      status: "DISCOVERED" as const,
    }));

    await prisma.wcTopic.createMany({
      data: scored,
      skipDuplicates: true,
    });
    console.log(`[wc:topicDiscovery] Inserted ${scored.length} topics`);
  }

  const topic = await prisma.wcTopic.findFirst({
    where: { status: TopicStatus.DISCOVERED },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
  });

  if (!topic) {
    return { success: false, error: "No viable topics", durationMs: Date.now() - start };
  }

  await prisma.wcTopic.update({
    where: { id: topic.id },
    data: { status: TopicStatus.APPROVED },
  });

  return { success: true, data: topic, durationMs: Date.now() - start };
}

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
        console.warn(`[wc:topicDiscovery] Failed to fetch ${source}: ${err}`);
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

function scoreTopic(item: FeedItem): number {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();

  const hits = KEYWORDS.filter((kw) => text.includes(kw)).length;
  const keywordScore = (hits / KEYWORDS.length) * 0.6;

  let recencyScore = 0.4;
  if (item.publishedAt) {
    const ageHours = (Date.now() - item.publishedAt.getTime()) / (1000 * 60 * 60);
    const halfLife = 24;
    recencyScore = Math.pow(0.5, ageHours / halfLife) * 0.4;
  }

  return Math.round((keywordScore + recencyScore) * 1000) / 1000;
}
