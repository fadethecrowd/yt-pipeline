import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, Script, StageResult } from "../types";

// ── Zod schema for Claude's JSON output ────────────────────────────────────

const segmentSchema = z.object({
  segmentIndex: z.number().int().min(0),
  title: z.string().min(1),
  narration: z.string().min(1),
  visual_prompt: z.string().min(1),
  duration_seconds: z.number().positive(),
});

const scriptSchema = z.object({
  hook: z.string().min(1),
  segments: z.array(segmentSchema).min(4).max(6),
  cta: z.string().min(1),
  estimatedTotalDuration: z.number().positive(),
});

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a YouTube scriptwriter for an AI/tech news channel.
You write punchy, engaging scripts optimized for viewer retention.

RULES:
- The hook must grab attention in the first 30 seconds
- Write 4-6 body segments, each covering a distinct angle of the story
- Narration should be conversational, clear, and suitable for text-to-speech
- Visual prompts describe what the viewer sees on screen (b-roll, graphics, text overlays)
- Each segment should be 30-90 seconds
- The CTA should encourage likes, subscribes, and comments
- Total video length: 3-6 minutes

Respond ONLY with valid JSON matching this exact structure:
{
  "hook": "attention-grabbing opening narration",
  "segments": [
    {
      "segmentIndex": 0,
      "title": "segment title",
      "narration": "voiceover text for this segment",
      "visual_prompt": "description of visuals to show",
      "duration_seconds": 45
    }
  ],
  "cta": "closing call to action narration",
  "estimatedTotalDuration": 240
}`;

/**
 * Stage 2: Use Claude API to generate a structured script JSON.
 * Output: hook, 4-6 body segments (each with visual_prompt), CTA.
 */
export async function scriptGenerator(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const config = env();

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const userPrompt = [
    `Write a YouTube script about this topic:`,
    ``,
    `Title: ${ctx.topic.title}`,
    `Source: ${ctx.topic.url}`,
    ctx.topic.summary ? `Summary: ${ctx.topic.summary}` : null,
    ``,
    `Make it informative, engaging, and suitable for a tech-savvy audience.`,
  ]
    .filter(Boolean)
    .join("\n");

  console.log(`[scriptGenerator] Calling Claude for: "${ctx.topic.title}"`);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Extract text from response
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

  // Validate with Zod
  const validation = scriptSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `Script validation failed: ${issues}`,
      durationMs: Date.now() - start,
    };
  }

  const script: Script = validation.data;

  console.log(
    `[scriptGenerator] Generated ${script.segments.length} segments, ~${script.estimatedTotalDuration}s total`
  );

  // Persist script and update status
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      scriptJson: script as any,
      status: VideoStatus.SCRIPT_DONE,
    },
  });

  ctx.script = script;

  return { success: true, data: script, durationMs: Date.now() - start };
}
