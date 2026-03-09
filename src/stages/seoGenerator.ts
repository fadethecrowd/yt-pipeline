import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, SEOMetadata, StageResult } from "../types";

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

// ── Zod schema for Claude's SEO output ───────────────────────────────────

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

// ── System prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a YouTube SEO expert for an AI/tech news channel.
Given a topic and script, generate metadata that maximizes search visibility and click-through rate.

Requirements:
- title: Compelling, keyword-rich, under 100 characters. Use power words. Do NOT use clickbait.
- description: 300-500 words. Include relevant keywords naturally. Start with a strong hook sentence.
  Include chapter timestamps (provided to you). End with a subscribe CTA and relevant links section.
- tags: 15-20 highly relevant tags. Mix broad terms (AI, technology) with specific ones (the topic).
- chapters: Use the exact timestamps provided. First chapter MUST start at 0:00.

Respond ONLY with valid JSON matching this structure:
{
  "title": "Your SEO Title Here",
  "description": "Full description with timestamps...",
  "tags": ["tag1", "tag2", ...],
  "chapters": [{"time": "0:00", "label": "Introduction"}, ...]
}`;

/**
 * Stage 6: Use Claude API to generate SEO-optimized title, description, tags, chapters.
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

  // Probe actual segment durations for accurate chapter timestamps
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

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const userPrompt = `Topic: ${ctx.topic.title}
Source: ${ctx.topic.url}

Chapter timestamps (use these exactly):
${chapterHints.join("\n")}

Full script:
${JSON.stringify(ctx.script, null, 2)}`;

  console.log(`[seoGenerator] Generating SEO metadata...`);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return {
      success: false,
      error: "No text in Claude response",
      durationMs: Date.now() - start,
    };
  }

  // Parse JSON — strip markdown fences if present
  let raw = textBlock.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error: `Invalid JSON from Claude: ${raw.slice(0, 200)}`,
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

  const seo: SEOMetadata = validation.data;

  console.log(`[seoGenerator] Title: ${seo.title}`);
  console.log(`[seoGenerator] Tags: ${seo.tags.length}`);
  console.log(`[seoGenerator] Chapters: ${seo.chapters.length}`);

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      seoTitle: seo.title,
      seoDescription: seo.description,
      seoTags: seo.tags,
      seoChapters: seo.chapters as any,
      status: VideoStatus.SEO_DONE,
    },
  });

  ctx.seo = seo;

  return { success: true, data: seo, durationMs: Date.now() - start };
}
