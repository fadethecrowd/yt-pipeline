import Parser from "rss-parser";
import { TopicStatus } from "@prisma/client";
import { prisma } from "@yt-pipeline/pipeline-core";
import type { FeedItem, PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// RSS feed sources for AI/tech news
const FEEDS: Record<string, string> = {
  // Existing publication / aggregator sources
  techcrunch: "https://techcrunch.com/category/artificial-intelligence/feed/",
  ars_technica: "https://feeds.arstechnica.com/arstechnica/technology-lab",
  hackernews: "https://hnrss.org/best?q=AI+OR+LLM+OR+GPT+OR+machine+learning",
  venturebeat: "https://venturebeat.com/category/ai/feed/",
  // AI lab official blogs (verified working as of 2026-04-16)
  openai_blog: "https://openai.com/blog/rss.xml",         // redirects to /news/rss.xml (~939 items)
  deepmind_blog: "https://deepmind.com/blog/feed/basic/", // ~100 items
  huggingface_blog: "https://huggingface.co/blog/feed.xml", // ~764 items
  // Probed but unavailable (no RSS published; do not add):
  //   anthropic_news, meta_ai, mistral_news — all 404 on every variant tried.
};

// Keywords to score relevance against. Editorial direction: AI Doom Scroll —
// favor capability shifts, system failures, infrastructure changes, agent
// reliability, security, policy/workforce moves over generic "startup uses AI"
// press fluff.
const KEYWORDS = [
  // Existing core (weak generic terms removed: ai, tool, startup)
  "llm", "model", "automation", "agent", "openai", "anthropic", "google",
  // Doom-aligned signals
  "outage", "failure", "vulnerability", "jailbreak", "regression",
  "exploit", "breach", "shutdown", "rollback",
  "alignment", "capability", "benchmark", "scaling",
  "safety", "policy", "ban", "lawsuit", "regulation", "layoff",
];

// Per-source multiplier applied to the final composite score. RSS source
// keys match those defined in FEEDS. Unmapped sources default to 1.0.
const SOURCE_WEIGHTS: Record<string, number> = {
  // First-party AI lab blogs — highest signal
  openai_blog: 1.5,
  deepmind_blog: 1.4,
  huggingface_blog: 1.3,
  // Community-validated aggregator
  hackernews: 1.3,
  // Demoted — broad/PR-heavy publications
  techcrunch: 0.7,
  ars_technica: 0.7,
  venturebeat: 0.6,
};

// Negative-keyword penalties — subtracted from raw keyword hit count
// (floored at 0) before computing keywordScore. Targets funding-round
// PR, vertical-SaaS launches, and generic "AI-powered X" marketing fluff.
//
// Regex with word boundaries + simple stemming so all conjugations match
// (e.g. raised/raises/raising/raise; launched/launches/launching/launch).
// Substring matching (the prior approach) missed every conjugation
// variant — see the e427e1e dry-run report for the leak this closes.
const NEGATIVE_PATTERNS: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\brais(e|es|ed|ing)\b/i, penalty: 5 },
  { pattern: /\bfund(ed|ing)?\b/i, penalty: 5 },
  { pattern: /\blaunch(es|ed|ing)?\b/i, penalty: 4 },
  { pattern: /\bvalu(e|ation)\b/i, penalty: 4 },
  { pattern: /\bseries\s+[abc]\b/i, penalty: 5 },
  { pattern: /\bnow\s+available\b/i, penalty: 4 },
  { pattern: /\bai-powered\b/i, penalty: 4 },
  { pattern: /\bfor\s+(marketing|sales|hr)\b/i, penalty: 4 },
];

// Mild technical/doom-depth bias. If a topic mentions NONE of these, its
// final score is multiplied by 0.75. Topics are NOT rejected, only
// deprioritised in favor of items with substantive technical content.
const TECHNICAL_CORE_KEYWORDS = [
  // Original set
  "benchmark",
  "alignment",
  "capability",
  "training",
  "scaling",
  "inference",
  "agent",
  "autonomous",
  "model evaluation",
  "safety",
  "hallucination",
  "regression",
  "exploit",
  "jailbreak",
  // Appended (commit notes: 3 duplicates from spec — autonomous, inference,
  // exploit — already above; new additions only):
  "coding",
  "code",
  "cyber",
  "defense",
  "tts",
  "speech",
  "multimodal",
  "embedding",
  "reranker",
  "transformer",
  "tool use",
  "reasoning",
  "evaluation",
  "benchmarking",
  "agentic",
  "fine-tuning",
  "finetuning",
  "prompting",
  "cve",
  "phishing",
  "malware",
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
        const items = (feed.items ?? []).map((item): FeedItem | null => {
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
        const valid = items.filter((i): i is FeedItem => i !== null);
        console.log(`[topicDiscovery]   ${source.padEnd(18)} → ${valid.length} items`);
        return items;
      } catch (err) {
        console.warn(`[topicDiscovery]   ${source.padEnd(18)} FAILED: ${err instanceof Error ? err.message : err}`);
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
 *   - Keyword relevance (0–0.6): doom-aligned keyword density,
 *     net of NEGATIVE_KEYWORDS penalties (floored at 0).
 *   - Recency (0–0.4): exponential decay, half-life of 24 hours.
 *   - Source weight: per-source multiplier (final step).
 *   - Technical-depth bias: ×0.75 if no TECHNICAL_CORE_KEYWORDS present.
 */
function scoreTopic(item: FeedItem): number {
  const text = `${item.title} ${item.summary ?? ""}`.toLowerCase();

  // Raw keyword hits (each KEYWORD = 1 point)
  const hits = KEYWORDS.filter((kw) => text.includes(kw)).length;

  // Negative-keyword penalty subtracted from hit count, floored at 0.
  // Regex matching catches conjugation variants substring matching missed.
  let negativePoints = 0;
  for (const { pattern, penalty } of NEGATIVE_PATTERNS) {
    if (pattern.test(text)) negativePoints += penalty;
  }
  const adjustedHits = Math.max(0, hits - negativePoints);
  const keywordScore = (adjustedHits / KEYWORDS.length) * 0.6;

  // Recency score: exponential decay with 24h half-life, weighted to 0.4
  let recencyScore = 0.4; // default to full if no date
  if (item.publishedAt) {
    const ageHours = (Date.now() - item.publishedAt.getTime()) / (1000 * 60 * 60);
    const halfLife = 24;
    recencyScore = Math.pow(0.5, ageHours / halfLife) * 0.4;
  }

  // Per-source weight as final multiplier. Editorial mix shaping.
  const sourceWeight = SOURCE_WEIGHTS[item.source] ?? 1.0;
  let total = (keywordScore + recencyScore) * sourceWeight;

  // Mild technical-depth bias — deprioritise items with no doom/tech signal.
  const hasTechnicalSignal = TECHNICAL_CORE_KEYWORDS.some((kw) => text.includes(kw));
  if (!hasTechnicalSignal) {
    total *= 0.75;
  }

  return Math.round(total * 1000) / 1000;
}
