import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { TopicStatus } from "@prisma/client";
import { prisma, env, createMessage, fetchLibraryTopic } from "@yt-pipeline/pipeline-core";
import type { FeedItem, PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Configuration ───────────────────────────────────────────────────────────

const RSS_FEEDS: Record<string, string> = {
  // Vendor feeds
  garmin: "https://www.garmin.com/en-US/newsroom/feed/",
  humminbird: "https://www.humminbird.com/rss.xml",
  victron: "https://www.victronenergy.com/blog/feed/",
  minnkota: "https://www.minnkotamotors.com/rss.xml",
  lithionics: "https://lithionicsbattery.com/blog/feed/",
  // Independent publications / how-to / standards
  panbo: "https://panbo.com/feed/",
  marinehowto: "https://marinehowto.com/feed/",
  practical_sailor: "https://www.practical-sailor.com/feed/",
  abyc: "https://abycinc.org/feed/",
  boattest: "https://www.boattest.com/rss.xml",
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

/**
 * Hard vetoes. An item matching any of these is dropped no matter how many
 * gate keywords it also hits.
 *
 * The gate above admits anything mentioning a vendor name, "gps" or "radar",
 * and Garmin's newsroom feed covers aviation, automotive, motorsport, fitness
 * and earnings alongside marine. That is how "Catalyst R1 racing radar",
 * "avionics navigation database", "zūmo XT3 motorcycle GPS" and a Q4 earnings
 * release all reached the scriptwriter — which correctly refused to write a
 * marine electronics script about them, at the cost of a wasted Claude call and
 * a failed pipeline run each time.
 */
const NON_MARINE_VETO_KEYWORDS = [
  // Aviation
  "avionics", "aircraft", "aviation", "cockpit", "autothrottle", "pilots",
  "airspace", "flight deck", "g1000", "g3000", "helicopter",
  // Automotive / motorsport
  "motorcycle", "motorsport", "racetrack", "race track", "racing radar",
  "car audio", "dash cam", "dashcam", "zumo", "zūmo", "catalyst",
  "lap time", "track day", "automotive",
  // Fitness / wearables
  "smartwatch", "fitness tracker", "running watch", "golf watch",
  "heart rate monitor", "cycling computer", "forerunner", "fenix", "vivoactive",
  // Corporate / financial
  "quarterly results", "fiscal year", "earnings", "dividend",
  "shareholder", "investor relations", "nasdaq", "annual report",
];

/** True when an item is from a non-marine product line or is corporate news. */
export function isNonMarine(text: string): string | null {
  const t = text.toLowerCase();
  return NON_MARINE_VETO_KEYWORDS.find((k) => t.includes(k)) ?? null;
}

/** Weighted scoring keywords — signals purchase intent and content value. */
const SCORING_KEYWORDS: Record<string, number> = {
  // Strong technical comparison signals (3-4 pts)
  vs: 3, versus: 3, comparison: 3, "head to head": 4,
  "real-world": 4, "field test": 4, "long-term": 4,
  // Technical depth — reliability / signal / power / install realities (2-3 pts)
  reliability: 3, tradeoff: 3, tradeoffs: 3,
  interference: 3, "signal quality": 3, "noise floor": 3,
  wiring: 3, nmea: 3, "nmea 2000": 3, ethernet: 2,
  "power draw": 3, "voltage drop": 3, "ground loop": 3,
  failure: 2, troubleshoot: 2, benchmark: 3,
  // Practical install / setup signals (2 pts)
  upgrade: 3, price: 2, install: 2, setup: 2, "hands on": 2,
  tutorial: 2, "how to": 2, settings: 2, mount: 2,
  // New product signals (2 pts each)
  new: 2, launch: 2, release: 2, announce: 2, "just dropped": 2,
  // Demoted consumer-fluff signals (1 pt — kept for relevance, not boosted)
  best: 1, review: 1, "top 5": 1, "top 10": 1, roundup: 1,
  // General marine relevance (1 pt each)
  fishfinder: 1, chartplotter: 1, sonar: 1, livescope: 1,
  garmin: 1, humminbird: 1, lowrance: 1, simrad: 1,
  transducer: 1, trolling: 1, autopilot: 1, radar: 1, vhf: 1,
};

const MAX_SCORING_POINTS = Object.values(SCORING_KEYWORDS).reduce((a, b) => a + b, 0);

/**
 * Per-source multiplier applied to the final composite score.
 * Lookup uses the same `source` string set when items are ingested
 * (RSS keys for RSS items, "reddit:r/{sub}" for Reddit items).
 * Unmapped sources default to 1.0.
 */
const SOURCE_WEIGHTS: Record<string, number> = {
  // High-value marine tech sources
  panbo: 1.5,
  marinehowto: 1.4,
  abyc: 1.4,
  garmin: 1.3,
  humminbird: 1.3,
  victron: 1.3,
  "reddit:r/livescope": 1.3,
  boattest: 1.2,
  lithionics: 1.1,
  // Neutral
  minnkota: 1.0,
  "reddit:r/boating": 1.0,
  // Slight demote — independent testing, some off-topic sailboat content
  practical_sailor: 0.9,
  // Demote — broad publications
  sportfishing: 0.8,
  passagemaker: 0.8,
  // Demote — broad fishing community
  "reddit:r/Fishing": 0.6,
  // Heavy demote — kayak/freshwater-fishing focus
  "reddit:r/kayakfishing": 0.5,
  wired2fish: 0.5,
  // Near-zero — boat photography (rarely tech)
  "reddit:r/boatporn": 0.3,
};

/**
 * Negative scoring weights — penalties subtracted from intent points
 * before computing intentScore. Targets kayak-rigging, beginner framing,
 * and consumer-list content that doesn't fit the marine-tech mandate.
 */
/**
 * Core technical-electronics signal. If a topic mentions NONE of these,
 * its final score is multiplied by 0.75 — a mild ranking-probability
 * reduction. Topics are NOT rejected or filtered, only deprioritised.
 */
const TECHNICAL_CORE_KEYWORDS = [
  "fishfinder",
  "chartplotter",
  "sonar",
  "livescope",
  "transducer",
  "nmea",
  "nmea 2000",
  "ethernet",
  "network",
  "radar",
  "vhf",
  "ais",
  "autopilot",
  "battery",
  "power draw",
  "voltage drop",
  "ground loop",
  "interference",
  "signal",
  "wiring",
  "marine electronics",
];

// Hard-disallow patterns for the Topic Library path. RSS/Reddit goes
// through scoreItem()'s NEGATIVE_KEYWORDS (penalty-based); the library
// path skipped scoring entirely, so disallowed topics (kayak / canoe /
// paddleboard / PWC / jet ski / personal watercraft) reached production
// with only a Minn-Kota-style positive signal. Rejecting them outright
// here closes that bypass.
const WC_LIBRARY_DISALLOWED: RegExp[] = [
  /\bkayak/i,
  /\bcanoe/i,
  /\bpaddle\s*board/i,
  /\bpaddleboard/i,
  /\bSUP\b/,
  /\bPWC\b/,
  /\bjet\s*ski/i,
  /\bjetski/i,
  /\bpersonal\s+watercraft/i,
  /\bwaverunner/i,
  /\bseadoo/i,
  /\bsea[- ]?doo/i,
];

function isWcLibraryDisallowed(t: { title: string; summary: string | null }): boolean {
  const text = `${t.title} ${t.summary ?? ""}`;
  return WC_LIBRARY_DISALLOWED.some((re) => re.test(text));
}

const NEGATIVE_KEYWORDS: Record<string, number> = {
  "kayak fishing": 5,
  "fishing kayak": 5,
  "first kayak": 5,
  "beginner kayak": 5,
  "rigging your kayak": 5,
  "kayak rigging": 5,
  "lifetime tamarack": 5,
  "gift guide": 5,
  "for beginners": 4,
  "first fish finder": 4,
  "fly fishing": 4,
  scupper: 3,
  pelican: 3,
  "bass fishing": 3,
  beginner: 3,
  tackle: 2,
  lure: 2,
  "what to buy": 2,
  kayak: 4,
  paddle: 3,
  canoe: 3,
  camping: 3,
};

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

  // 0. Check Topic Library first — curated topics take priority over discovery.
  //    In DRY_RUN mode (DISABLE_ELEVEN=true), reserve the topic so it can be reused.
  //    Disallowed topics (kayak / canoe / paddleboard / PWC / jet ski / etc) are
  //    archived inside fetchLibraryTopic and skipped over — mirrors the same policy
  //    NEGATIVE_KEYWORDS enforces on the RSS/Reddit discovery path.
  const isDryRun = process.env.DISABLE_ELEVEN === "true";
  const libraryTopic = await fetchLibraryTopic(
    "wet-circuit",
    isDryRun,
    isWcLibraryDisallowed,
  );
  if (libraryTopic) {
    const topic = await prisma.wcTopic.upsert({
      where: { url: libraryTopic.url },
      create: {
        title: libraryTopic.title,
        url: libraryTopic.url,
        source: libraryTopic.source,
        summary: libraryTopic.summary,
        score: 100,
        status: "APPROVED" as const,
      },
      update: { status: "APPROVED" as const },
    });
    console.log(`[wc:topicDiscovery] Using library topic: "${topic.title}"`);
    return { success: true, data: topic, durationMs: Date.now() - start };
  }

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

export function passesRelevanceGate(item: FeedItem): boolean {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();

  // Veto wins over any keyword match: a non-marine product line mentioning
  // "garmin", "gps" or "radar" must not reach the scriptwriter.
  const veto = isNonMarine(text);
  if (veto) {
    console.log(`[wc:topicDiscovery] vetoed (non-marine: "${veto}"): ${item.title.slice(0, 80)}`);
    return false;
  }

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
  // Subtract penalty for kayak-fluff / beginner-framing / consumer-list signals.
  // Floor at 0 so a single irrelevant phrase can't drive intentScore negative.
  let negativePoints = 0;
  for (const [kw, penalty] of Object.entries(NEGATIVE_KEYWORDS)) {
    if (text.includes(kw)) negativePoints += penalty;
  }
  const adjustedKeywordPoints = Math.max(0, keywordPoints - negativePoints);
  const intentScore = Math.min(40, (adjustedKeywordPoints / MAX_SCORING_POINTS) * 100);

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

  // Apply per-source weight as final multiplier. Editorial mix shaping.
  const sourceWeight = SOURCE_WEIGHTS[item.source] ?? 1.0;
  let total = (intentScore + recencyScore + engagementScore + relevanceScore) * sourceWeight;

  // Mild electronics-relevance bias — topics with no technical-core signal
  // are deprioritised but NOT rejected. Lets a help-thread with broad
  // marine-tech edges still surface, while letting deeply technical content
  // outrank it on equal recency/engagement.
  const hasTechnicalSignal = TECHNICAL_CORE_KEYWORDS.some((kw) => text.includes(kw));
  if (!hasTechnicalSignal) {
    total *= 0.75;
  }

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
