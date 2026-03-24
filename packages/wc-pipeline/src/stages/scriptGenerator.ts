import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma, env } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, StageResult } from "@yt-pipeline/pipeline-core";

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

const SYSTEM_PROMPT = `You are a YouTube scriptwriter for a marine electronics channel called "Wet Circuit".
You write clear, informative scripts for boaters and marine electronics enthusiasts.

RULES:
- The hook must grab attention in the first 30 seconds
- Write 4-6 body segments, each covering a distinct angle of the product/topic
- Narration should be conversational, clear, and suitable for text-to-speech
- Visual prompts describe what the viewer sees on screen (product shots, on-water footage, diagrams, UI screenshots)
- Each segment should be 30-90 seconds
- The CTA should encourage likes, subscribes, and comments
- Total video length: 3-6 minutes
- Focus on practical advice boaters can use — installation tips, comparisons, real-world performance

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

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

/**
 * Generate a script, optionally with rewrite feedback from quality gate.
 */
export async function generateScript(
  anthropic: Anthropic,
  ctx: PipelineContext,
  feedback?: string,
): Promise<{ script?: Script; error?: string }> {
  const parts = [
    `Write a YouTube script about this marine electronics topic:`,
    ``,
    `Title: ${ctx.topic.title}`,
    `Source: ${ctx.topic.url}`,
    ctx.topic.summary ? `Summary: ${ctx.topic.summary}` : null,
    ``,
    `Make it informative, engaging, and useful for boaters considering this equipment.`,
  ];

  if (feedback) {
    parts.push(
      ``,
      `IMPORTANT: A previous version of this script was rejected by quality review. Fix these issues:`,
      feedback,
      ``,
      `Rewrite the script addressing all of the above feedback.`,
    );
  }

  const userPrompt = parts.filter(Boolean).join("\n");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { error: "No text in Claude response" };
  }

  let parsed: unknown;
  try {
    parsed = parseJSON(textBlock.text);
  } catch {
    return { error: `Invalid JSON from Claude: ${textBlock.text.slice(0, 200)}` };
  }

  const validation = scriptSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { error: `Script validation failed: ${issues}` };
  }

  return { script: validation.data };
}

/**
 * Stage 2: Use Claude API to generate a structured script JSON
 * tailored for marine electronics content.
 *
 * TODO: Customize prompts and script structure for Wet Circuit channel.
 */
export async function scriptGenerator(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  console.log(`[wc:scriptGenerator] Generating script for: "${ctx.topic.title}"`);

  const result = await generateScript(anthropic, ctx);

  if (result.error || !result.script) {
    return {
      success: false,
      error: result.error ?? "No script generated",
      durationMs: Date.now() - start,
    };
  }

  const script = result.script;

  console.log(
    `[wc:scriptGenerator] Generated ${script.segments.length} segments, ~${script.estimatedTotalDuration}s total`
  );

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      scriptJson: script as any,
      status: VideoStatus.SCRIPT_DONE,
    },
  });

  ctx.script = script;

  return { success: true, data: script, durationMs: Date.now() - start };
}

export { type Anthropic };
