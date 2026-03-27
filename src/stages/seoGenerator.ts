import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, SEOMetadata, StageResult } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);
const FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFile(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Zod schemas ─────────────────────────────────────────────────────────

const seoSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(300),
  tags: z.array(z.string()).min(15).max(25),
  chapters: z.array(
    z.object({
      time: z.string().regex(/^\d+:\d{2}$/),
      label: z.string().min(1),
    })
  ).min(2),
});

const titleCandidateSchema = z.array(
  z.object({ title: z.string(), rationale: z.string() })
).min(3);

const titleScoreSchema = z.array(
  z.object({
    title: z.string(),
    scores: z.object({
      curiosity_gap: z.number(),
      specificity: z.number(),
      search_intent_match: z.number(),
      urgency: z.number(),
    }),
    total: z.number(),
  })
);

const titleRewriteSchema = z.array(
  z.object({
    title: z.string(),
    type: z.enum(["refined", "wildcard"]),
    reasoning: z.string(),
  })
);

// ── Helpers ─────────────────────────────────────────────────────────────

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

async function callClaude(
  anthropic: Anthropic,
  system: string,
  userPrompt: string,
  maxTokens = 2048,
): Promise<string> {
  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

// ── Title generation loop (3 rounds) ────────────────────────────────────

interface TitleResult {
  primary: string;
  primaryScore: number;
  variantB: string;
  variantC: string;
}

async function generateTitles(
  anthropic: Anthropic,
  topicTitle: string,
  scriptSummary: string,
): Promise<TitleResult> {
  // Round 1 — generate candidates
  console.log("[seoGenerator] Title round 1: generating candidates...");
  const round1Raw = await callClaude(
    anthropic,
    "You are a YouTube title expert for an AI/tech news channel.",
    `Generate 5 YouTube title candidates for this script.

Topic: ${topicTitle}
Script summary: ${scriptSummary}

Each title must: be under 70 characters, create a curiosity gap,
be specific (not vague), avoid clickbait that doesn't deliver.
Return ONLY a JSON array: [{"title": "...", "rationale": "..."}]`,
    1024,
  );

  const candidates = titleCandidateSchema.parse(parseJSON(round1Raw));
  console.log(`[seoGenerator] Round 1: ${candidates.length} candidates generated`);
  for (const c of candidates) {
    console.log(`[seoGenerator]   "${c.title}"`);
  }

  // Round 2 — score them
  console.log("[seoGenerator] Title round 2: scoring...");
  const round2Raw = await callClaude(
    anthropic,
    "You are a YouTube title analyst. Score titles objectively.",
    `Score each of these 5 titles from 1-10 on these dimensions:
- curiosity_gap
- specificity
- search_intent_match
- urgency
Return ONLY JSON: [{"title": "...", "scores": {"curiosity_gap": N, "specificity": N, "search_intent_match": N, "urgency": N}, "total": N}]

Titles to score:
${JSON.stringify(candidates.map((c) => c.title))}`,
    1024,
  );

  const scored = titleScoreSchema.parse(parseJSON(round2Raw));
  scored.sort((a, b) => b.total - a.total);
  console.log("[seoGenerator] Round 2 scores:");
  for (const s of scored) {
    console.log(`[seoGenerator]   ${s.total}/40 "${s.title}"`);
  }

  const top2 = scored.slice(0, 2);

  // Round 3 — rewrite top 2 + wildcard
  console.log("[seoGenerator] Title round 3: rewriting top 2 + wildcard...");
  const round3Raw = await callClaude(
    anthropic,
    "You are a YouTube CTR optimization expert.",
    `Rewrite these 2 titles to maximize CTR.
Apply: stronger verbs, cut filler words, front-load the hook.
Also generate 1 wildcard title that breaks the pattern entirely.
Return ONLY JSON: [{"title": "...", "type": "refined" | "wildcard", "reasoning": "..."}]

Titles to rewrite:
1. "${top2[0].title}" (score: ${top2[0].total}/40)
2. "${top2[1].title}" (score: ${top2[1].total}/40)

Topic: ${topicTitle}`,
    1024,
  );

  const rewritten = titleRewriteSchema.parse(parseJSON(round3Raw));
  const refined = rewritten.filter((r) => r.type === "refined");
  const wildcard = rewritten.find((r) => r.type === "wildcard");

  console.log("[seoGenerator] Round 3 results:");
  for (const r of rewritten) {
    console.log(`[seoGenerator]   [${r.type}] "${r.title}" — ${r.reasoning}`);
  }

  // Auto-select: highest-scoring refined title is primary, second refined is B, wildcard is C
  const primary = refined[0]?.title ?? top2[0].title;
  const variantB = refined[1]?.title ?? refined[0]?.title ?? top2[1].title;
  const variantC = wildcard?.title ?? (refined.length > 2 ? refined[2].title : top2[1].title);

  return {
    primary,
    primaryScore: top2[0].total,
    variantB,
    variantC,
  };
}

// ── System prompt for description/tags/chapters ─────────────────────────

const SEO_SYSTEM_PROMPT = `You are a YouTube SEO expert for an AI/tech news channel.
Given a topic, script, and a pre-selected title, generate the remaining metadata.

Requirements:
- description: 300-500 words. Include relevant keywords naturally. Start with a strong hook sentence.
  Include chapter timestamps (provided to you). End with a subscribe CTA and relevant links section.
- tags: 15-20 highly relevant tags. Mix broad terms (AI, technology) with specific ones (the topic).
- chapters: Use the exact timestamps provided. First chapter MUST start at 0:00.

Respond ONLY with valid JSON matching this structure:
{
  "title": "The pre-selected title (copy it exactly)",
  "description": "Full description with timestamps...",
  "tags": ["tag1", "tag2", ...],
  "chapters": [{"time": "0:00", "label": "Introduction"}, ...]
}`;

/**
 * Stage 6: Use Claude API to generate SEO-optimized title, description, tags, chapters.
 * Title generation uses a 3-round loop: generate → score → rewrite.
 */
export async function seoGenerator(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.SEO_PENDING },
  });

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  // ── Title generation (3-round loop) ──────────────────────────────────
  const scriptSummary = ctx.script.hook + " " +
    ctx.script.segments.map((s) => s.title).join(". ");

  const titles = await generateTitles(anthropic, ctx.topic.title, scriptSummary);

  console.log(`[seoGenerator] Selected title: "${titles.primary}"`);
  console.log(`[seoGenerator] Variant B: "${titles.variantB}"`);
  console.log(`[seoGenerator] Variant C (wildcard): "${titles.variantC}"`);

  // ── Chapter timestamps from audio ────────────────────────────────────
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  const chapterHints: string[] = ["0:00 — Introduction (title card)"];
  let offset = 4; // title card duration
  for (const seg of ctx.script.segments) {
    const mp3Path = join(audioDir, `segment-${seg.segmentIndex}.mp3`);
    let dur: number;
    try {
      dur = await probeDuration(mp3Path);
    } catch {
      dur = seg.duration_seconds; // fallback to estimate
    }
    chapterHints.push(`${formatTimestamp(offset)} — ${seg.title}`);
    offset += dur;
  }

  console.log(`[seoGenerator] Chapter timestamps from audio:`);
  for (const c of chapterHints) console.log(`  ${c}`);

  // ── Generate description, tags, chapters ─────────────────────────────
  const userPrompt = `Title (use this exactly): ${titles.primary}

Topic: ${ctx.topic.title}
Source: ${ctx.topic.url}

Chapter timestamps (use these exactly):
${chapterHints.join("\n")}

Full script:
${JSON.stringify(ctx.script, null, 2)}`;

  console.log(`[seoGenerator] Generating description, tags, chapters...`);

  const seoRaw = await callClaude(anthropic, SEO_SYSTEM_PROMPT, userPrompt);

  let parsed: unknown;
  try {
    parsed = parseJSON(seoRaw);
  } catch {
    return {
      success: false,
      error: `Invalid JSON from Claude: ${seoRaw.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }

  const validation = seoSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `SEO validation failed: ${issues}`,
      durationMs: Date.now() - start,
    };
  }

  // Override the title with our 3-round winner
  const seo: SEOMetadata = { ...validation.data, title: titles.primary };

  console.log(`[seoGenerator] Title: ${seo.title}`);
  console.log(`[seoGenerator] Tags: ${seo.tags.length}`);
  console.log(`[seoGenerator] Chapters: ${seo.chapters.length}`);

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      seoTitle: seo.title,
      titleVariantB: titles.variantB,
      titleVariantC: titles.variantC,
      seoDescription: seo.description,
      seoTags: seo.tags,
      seoChapters: seo.chapters as any,
      status: VideoStatus.SEO_DONE,
    },
  });

  ctx.seo = seo;

  return { success: true, data: seo, durationMs: Date.now() - start };
}
