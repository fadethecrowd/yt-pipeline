import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { TopicStatus } from "@prisma/client";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
import type { FeedItem, PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Configuration ───────────────────────────────────────────────────────────

const RSS_FEEDS: Record<string, string> = {
  garmin: "https://www.garmin.com/en-US/newsroom/feed/",
  humminbird: "https://www.humminbird.com/blogs/news.atom",
  lowrance: "https://www.lowrance.com/en-us/news/feed/",
  simrad: "https://www.simrad-yachting.com/en-us/news/feed/",
  panbo: "https://panbo.com/feed/",
  passagemaker: "https://www.passagemaker.com/feed",
  sportfishing: "https://www.sportfishingmag.com/feed/",
  wired2fish: "https://wired2fish.com/feed/",
};

const REDDIT_SUBS = ["Fishing", "kayakfishing", "boating", "livescope", "boatporn"];
const REDDIT_USER_AGENT = "wc-pipeline/0.1.0";

/** Topics that don't mention any of these are filtered out entirely. */
const RELEVANCE_GATE_KEYWORDS = [
  "fishfinder", "fish finder", "chartplotter", "chart plotter", "sonar",
  "livescope", "mega imaging", "mega live", "mega 360", "activetarget",
  "active target", "side imaging", "down imaging", "chirp",
  "garmin", "humminbird", "lowrance", "simrad", "raymarine", "furuno", "navico",
  "nmea", "nmea 2000", "vhf", "ais", "radar", "autopilot", "trolling motor",
  "minn kota", "motorguide", "ultrex", "terrova",
  "marine electronics", "boat electronics", "transducer",
  "gps", "plotter", "depth finder", "echomap", "helix", "solix",
  "axiom", "elite", "hds", "hook reveal", "nss", "nso",
];

/** Weighted scoring keywords — signals purchase intent and content value. */
const SCORING_KEYWORDS: Record<string, number> = {
  // Strong purchase-intent signals (3 pts each)
  best: 3, review: 3, vs: 3, versus: 3, comparison: 3,
  upgrade: 3, "top 5": 3, "top 10": 3, roundup: 3,
  // Product / price signals (2 pts each)
  price: 2, install: 2, setup: 2, unbox: 2, "hands on": 2,
  tutorial: 2, "how to": 2, settings: 2, mount: 2,
  // New product signals (2 pts each)
  new: 2, launch: 2, release: 2, announce: 2, "just dropped": 2,
  // General marine relevance (1 pt each)
  fishfinder: 1, chartplotter: 1, sonar: 1, livescope: 1,
  garmin: 1, humminbird: 1, lowrance: 1, simrad: 1,
  transducer: 1, trolling: 1, autopilot: 1, radar: 1, vhf: 1,
};

const MAX_SCORING_POINTS = Object.values(SCORING_KEYWORDS).reduce((a, b) => a + b, 0);

// ── Pillar types ────────────────────────────────────────────────────────────

type Pillar = "RANKED_LIST" | "HEAD_TO_HEAD" | "NEW_OWNER" | "NEW_DROP";

// ── Internal types ──────────────────────────────────────────────────────────

interface ScoredItem extends FeedItem {
  score: number;
  pillar: Pillar;
  engagement: number; // Reddit upvotes, 0 for RSS
}

interface RedditPost {
  title: string;
  url: string;
  subreddit: string;
  score: number;
  numComments: number;
  selftext: string;
}

// ── Entry point ─────────────────────────────────────────────────────────────

const parser = new Parser();
const TOP_N = 5;

/**
 * Stage 1 — Wet Circuit topic discovery.
 *
 * 1. Scrape RSS feeds + Reddit for marine-electronics content
 * 2. Gate on relevance keywords (must mention marine electronics)
 * 3. Score 0-100: purchase intent, recency, engagement, relevance
 * 4. Classify into content pillars via Claude
 * 5. Deduplicate against wc_topic table
 * 6. Persist top 5 to DB, return highest-scored DISCOVERED topic
 */
export async function topicDiscovery(
  _ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  // 1. Gather items from RSS + Reddit in parallel
  const [rssItems, redditItems] = await Promise.all([
    fetchRssFeeds(),
    fetchRedditPosts(),
  ]);

  const allItems = [...rssItems, ...redditItems];
  console.log(
    `[wc:topicDiscovery] Fetched ${rssItems.length} RSS + ${redditItems.length} Reddit = ${allItems.length} total`,
  );

  // 2. Relevance gate — drop anything that doesn't mention marine electronics
  const relevant = allItems.filter((item) => passesRelevanceGate(item));
  console.log(`[wc:topicDiscovery] ${relevant.length} items pass relevance gate`);

  if (relevant.length === 0) {
    return { success: false, error: "No relevant marine electronics topics found", durationMs: Date.now() - start };
  }

  // 3. Deduplicate against existing DB URLs
  const existingUrls = new Set(
    (
      await prisma.wcTopic.findMany({
        where: { url: { in: relevant.map((i) => i.url) } },
        select: { url: true },
      })
    ).map((t) => t.url),
  );
  const newItems = relevant.filter((i) => !existingUrls.has(i.url));
  console.log(`[wc:topicDiscovery] ${newItems.length} new items after dedup`);

  if (newItems.length === 0) {
    // Fall through to pick existing DISCOVERED topic
    return pickBestTopic(start);
  }

  // 4. Score every item
  const scored: ScoredItem[] = newItems.map((item) => ({
    ...item,
    score: scoreItem(item),
    pillar: "NEW_OWNER" as Pillar, // placeholder — classified below
    engagement: (item as any)._engagement ?? 0,
  }));

  // Sort by score desc, take top N for pillar classification (saves Claude tokens)
  scored.sort((a, b) => b.score - a.score);
  const topScored = scored.slice(0, TOP_N);

  // 5. Classify pillars via Claude
  const classified = await classifyPillars(topScored);

  // 6. Persist to wc_topic
  if (classified.length > 0) {
    await prisma.wcTopic.createMany({
      data: classified.map((item) => ({
        title: item.title,
        url: item.url,
        source: item.source,
        summary: buildSummary(item),
        score: item.score,
        status: "DISCOVERED" as const,
      })),
      skipDuplicates: true,
    });
    console.log(`[wc:topicDiscovery] Inserted ${classified.length} topics`);
  }

  return pickBestTopic(start);
}

// ── RSS fetching ────────────────────────────────────────────────────────────

async function fetchRssFeeds(): Promise<FeedItem[]> {
  const results: FeedItem[] = [];

  const settled = await Promise.allSettled(
    Object.entries(RSS_FEEDS).map(async ([source, url]) => {
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
        console.warn(`[wc:topicDiscovery] RSS failed for ${source}: ${err}`);
        return [];
      }
    }),
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

// ── Reddit fetching ─────────────────────────────────────────────────────────

async function fetchRedditPosts(): Promise<FeedItem[]> {
  const allPosts: RedditPost[] = [];

  const settled = await Promise.allSettled(
    REDDIT_SUBS.map(async (sub) => {
      try {
        const url = `https://www.reddit.com/r/${sub}/hot.json?limit=25&t=day`;
        const res = await fetch(url, {
          headers: { "User-Agent": REDDIT_USER_AGENT },
        });
        if (!res.ok) {
          console.warn(`[wc:topicDiscovery] Reddit r/${sub}: ${res.status}`);
          return [];
        }
        const data = (await res.json()) as any;
        const posts: RedditPost[] = [];
        for (const child of data?.data?.children ?? []) {
          const p = child.data;
          if (!p.url || p.stickied) continue;
          posts.push({
            title: p.title ?? "",
            url: `https://www.reddit.com${p.permalink}`,
            subreddit: sub,
            score: p.score ?? 0,
            numComments: p.num_comments ?? 0,
            selftext: (p.selftext ?? "").slice(0, 500),
          });
        }
        return posts;
      } catch (err) {
        console.warn(`[wc:topicDiscovery] Reddit r/${sub} error: ${err}`);
        return [];
      }
    }),
  );

  for (const result of settled) {
    if (result.status === "fulfilled") {
      allPosts.push(...result.value);
    }
  }

  // Convert to FeedItem, stashing engagement metadata
  return allPosts.map((p): FeedItem & { _engagement: number } => ({
    title: p.title,
    url: p.url,
    source: `reddit:r/${p.subreddit}`,
    summary: p.selftext || undefined,
    publishedAt: undefined, // Reddit JSON doesn't give ISO dates in listing
    _engagement: p.score + p.numComments * 2, // comments weighted 2x
  }));
}

// ── Relevance gate ──────────────────────────────────────────────────────────

function passesRelevanceGate(item: FeedItem): boolean {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  return RELEVANCE_GATE_KEYWORDS.some((kw) => text.includes(kw));
}

// ── Scoring (0–100) ─────────────────────────────────────────────────────────

function scoreItem(item: FeedItem & { _engagement?: number }): number {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();

  // Purchase-intent / keyword score (0-40)
  let keywordPoints = 0;
  for (const [kw, weight] of Object.entries(SCORING_KEYWORDS)) {
    if (text.includes(kw)) keywordPoints += weight;
  }
  const intentScore = Math.min(40, (keywordPoints / MAX_SCORING_POINTS) * 100);

  // Recency score (0-25): exponential decay, 24h half-life
  let recencyScore = 25;
  if (item.publishedAt) {
    const ageHours = (Date.now() - item.publishedAt.getTime()) / (1000 * 60 * 60);
    recencyScore = Math.pow(0.5, ageHours / 24) * 25;
  }

  // Engagement score (0-20): log-scaled Reddit engagement
  let engagementScore = 0;
  const engagement = item._engagement ?? 0;
  if (engagement > 0) {
    // log10(1) = 0, log10(10) = 1, log10(100) = 2, log10(1000) = 3
    // Cap at ~1000 engagement for full 20 pts
    engagementScore = Math.min(20, (Math.log10(engagement + 1) / 3) * 20);
  }

  // Relevance density score (0-15): how many gate keywords appear
  let relevanceHits = 0;
  for (const kw of RELEVANCE_GATE_KEYWORDS) {
    if (text.includes(kw)) relevanceHits++;
  }
  const relevanceScore = Math.min(15, (relevanceHits / 5) * 15);

  const total = intentScore + recencyScore + engagementScore + relevanceScore;
  return Math.round(Math.min(100, total) * 10) / 10;
}

// ── Pillar classification via Claude ────────────────────────────────────────

const PILLAR_SYSTEM = `You classify marine electronics YouTube video topics into exactly one content pillar.

Pillars:
- RANKED_LIST: "Top 5", "Top 10", product roundups, "best X for Y" lists
- HEAD_TO_HEAD: Direct brand-vs-brand or model-vs-model comparisons ("Garmin vs Humminbird", "LiveScope vs ActiveTarget")
- NEW_OWNER: Beginner education, explainers, "what you need to know", setup guides, installation tips
- NEW_DROP: New product announcements, releases, first looks, launch coverage

Respond with ONLY a JSON array of objects: [{"index": 0, "pillar": "RANKED_LIST"}, ...]
One entry per topic, using the index from the input list. No extra text.`;

async function classifyPillars(items: ScoredItem[]): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const topicList = items
    .map((item, i) => `${i}. "${item.title}" — ${item.summary?.slice(0, 120) ?? "(no summary)"}`)
    .join("\n");

  try {
    const message = await createMessage(anthropic, {
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: PILLAR_SYSTEM,
      messages: [{ role: "user", content: `Classify these topics:\n\n${topicList}` }],
    });

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array in response");

    const classifications: { index: number; pillar: Pillar }[] = JSON.parse(jsonMatch[0]);

    for (const c of classifications) {
      if (items[c.index] && isValidPillar(c.pillar)) {
        items[c.index].pillar = c.pillar;
      }
    }
  } catch (err) {
    console.warn(`[wc:topicDiscovery] Pillar classification failed, using fallback: ${err}`);
    // Fallback: heuristic pillar assignment
    for (const item of items) {
      item.pillar = heuristicPillar(item);
    }
  }

  return items;
}

function isValidPillar(p: string): p is Pillar {
  return ["RANKED_LIST", "HEAD_TO_HEAD", "NEW_OWNER", "NEW_DROP"].includes(p);
}

function heuristicPillar(item: ScoredItem): Pillar {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  if (/top \d|best \d|roundup|\d+ best/.test(text)) return "RANKED_LIST";
  if (/\bvs\b|versus|compared|comparison|head.to.head/.test(text)) return "HEAD_TO_HEAD";
  if (/new|launch|release|announce|first look|just dropped/.test(text)) return "NEW_DROP";
  return "NEW_OWNER";
}

// ── Summary builder ─────────────────────────────────────────────────────────

function buildSummary(item: ScoredItem): string {
  const parts = [`[${item.pillar}]`];
  if (item.summary) parts.push(item.summary.slice(0, 400));
  if (item.engagement > 0) parts.push(`(engagement: ${item.engagement})`);
  return parts.join(" ");
}

// ── Pick best topic from DB ─────────────────────────────────────────────────

async function pickBestTopic(startMs: number): Promise<StageResult> {
  const topic = await prisma.wcTopic.findFirst({
    where: { status: TopicStatus.DISCOVERED },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
  });

  if (!topic) {
    return { success: false, error: "No viable topics", durationMs: Date.now() - startMs };
  }

  await prisma.wcTopic.update({
    where: { id: topic.id },
    data: { status: TopicStatus.APPROVED },
  });

  console.log(`[wc:topicDiscovery] Selected topic: "${topic.title}" (score: ${topic.score})`);
  return { success: true, data: topic, durationMs: Date.now() - startMs };
}
