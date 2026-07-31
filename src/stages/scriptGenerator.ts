import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, StageResult } from "@yt-pipeline/pipeline-core";

/**
 * Target runtime for the script being written. Defaults to the channel's
 * historical 3-6 minute instruction; qualification and production runs set
 * TARGET_RUNTIME_SECONDS so the script is actually long enough for the
 * channel's real published length (median 5:50, up to 7:53).
 */
function lengthInstruction(): string {
  const t = Number(process.env.TARGET_RUNTIME_SECONDS ?? 0);
  if (!t) return "3-6 minutes";
  const mins = (t / 60).toFixed(1);
  // Measured from the approved diagnostic: 12.86 spoken characters per second.
  const chars = Math.round((t - 4) * 12.86);
  const words = Math.round(chars / 6.1);
  const segments = Math.max(4, Math.min(6, Math.round((t - 4) / 75)));
  const perSegment = Math.round(words / segments);
  return `${mins} minutes.

LENGTH BUDGET — this is a hard budget, not a suggestion:
- Write exactly ${segments} body segments.
- Each segment's narration must be approximately ${perSegment} words (±15%).
- TOTAL narration across hook + all ${segments} segments + CTA must be ${words} words (${chars} characters).
- Do NOT exceed ${Math.round(words * 1.2)} words in total. Going long is a failure, not thoroughness.
- Count as you write. Stop when the budget is met`;
}

const TITLE_CARD_OFFSET = 4; // seconds — matches videoAssembly title card duration

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

function systemPrompt(): string { return `You are a YouTube scriptwriter for an AI/tech news channel.
You write punchy, engaging scripts optimized for viewer retention.

RULES:
- The hook must grab attention in the first 30 seconds
- Write 4-6 body segments, each covering a distinct angle of the story
- Narration should be conversational, clear, and suitable for text-to-speech
- Visual prompts describe what the viewer sees on screen (b-roll, graphics, text overlays)
- Each segment should be 30-90 seconds
- The CTA should encourage likes, subscribes, and comments
- Total video length: ${lengthInstruction()}

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
}`; }

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

// ── Hook/CTA folding ────────────────────────────────────────────────────────
//
// The voiceover stage only renders segments[].narration — script.hook and
// script.cta were generated and quality-scored but never voiced. Fold the
// hook into the first segment's narration and the CTA into the last so they
// are actually spoken, while keeping segment count, titles, visual prompts,
// and downstream subtitle/chapter timing assumptions unchanged. The hook/cta
// fields stay on the script: thumbnailHeadlineGenerator and seoGenerator
// read them for prompt context. Lives inside generateScript so qualityGate's
// rewrite path (which persists generateScript output directly) is covered.

const NARRATION_WORDS_PER_SECOND = 2.5; // ≈150 wpm TTS pace, estimates only

function estimateSpokenSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round(words / NARRATION_WORDS_PER_SECOND);
}

export function foldHookAndCtaIntoSegments(script: Script): Script {
  const segments = script.segments.map((s) => ({ ...s }));
  const first = segments[0];
  const last = segments[segments.length - 1];
  const hookSecs = estimateSpokenSeconds(script.hook);
  const ctaSecs = estimateSpokenSeconds(script.cta);
  first.narration = `${script.hook} ${first.narration}`.trim();
  first.duration_seconds += hookSecs;
  last.narration = `${last.narration} ${script.cta}`.trim();
  last.duration_seconds += ctaSecs;
  return {
    ...script,
    segments,
    estimatedTotalDuration: script.estimatedTotalDuration + hookSecs + ctaSecs,
  };
}

async function generateScript(
  anthropic: Anthropic,
  ctx: PipelineContext,
  feedback?: string,
): Promise<{ script?: Script; error?: string }> {
  const parts = [
    `Write a YouTube script about this topic:`,
    ``,
    `Title: ${ctx.topic.title}`,
    `Source: ${ctx.topic.url}`,
    ctx.topic.summary ? `Summary: ${ctx.topic.summary}` : null,
    ``,
    `Make it informative, engaging, and suitable for a tech-savvy audience.`,
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

  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemPrompt(),
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

  return { script: foldHookAndCtaIntoSegments(validation.data) };
}

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

  console.log(`[scriptGenerator] Generating script for: "${ctx.topic.title}"`);

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
    `[scriptGenerator] Generated ${script.segments.length} segments, ~${script.estimatedTotalDuration}s total`
  );

  // Compute hookSegment for Shorts clipping. segments[0].narration already
  // begins with the hook (folded in by generateScript), so it is the caption
  // source 1:1 with voiced audio — no unvoiced text. startTime is 0:04
  // because narration begins after the title card (audio delayed by
  // TITLE_CARD_OFFSET in videoAssembly's final mux).
  const firstSeg = script.segments[0];
  const hookEndSeconds = TITLE_CARD_OFFSET + (firstSeg?.duration_seconds ?? 45);
  const hookSegment = JSON.stringify({
    text: (firstSeg?.narration ?? "").trim(),
    startTime: `0:0${TITLE_CARD_OFFSET}`,
    endTime: `0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`,
    segmentIndex: 0,
  });

  console.log(`[scriptGenerator] hookSegment: 0:0${TITLE_CARD_OFFSET}-0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`);

  // Persist script and update status
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      scriptJson: script as any,
      hookSegment,
      status: VideoStatus.SCRIPT_DONE,
    },
  });

  ctx.script = script;

  return { success: true, data: script, durationMs: Date.now() - start };
}

/**
 * Exposed for use by qualityGate's rewrite loop.
 */
export { generateScript, type Anthropic };
