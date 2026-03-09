import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, StageResult } from "../types";

// ── Zod schema for Claude's scoring output ─────────────────────────────────

const qualitySchema = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()).min(1),
  verdict: z.string().min(1),
});

export type QualityResult = z.infer<typeof qualitySchema>;

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior YouTube content quality reviewer for an AI/tech news channel.
You score scripts on a 0-100 scale across five dimensions.

SCORING RUBRIC:
- Hook strength (0-20): Does the opening grab attention within 30 seconds? Is it compelling enough to stop scrolling?
- Educational value (0-20): Does the script teach something useful? Are claims accurate and well-explained?
- Narrative flow (0-20): Do segments connect logically? Is there a clear arc from intro to conclusion?
- AI/Tech relevance (0-20): Is the content on-niche for an AI/tech audience? Does it cover meaningful developments?
- CTA clarity (0-20): Is the call to action clear, natural, and motivating?

Sum the five dimensions for the total score (0-100).

Respond ONLY with valid JSON matching this exact structure:
{
  "score": 85,
  "reasons": [
    "Hook strength (18/20): ...",
    "Educational value (16/20): ...",
    "Narrative flow (17/20): ...",
    "AI/Tech relevance (18/20): ...",
    "CTA clarity (16/20): ..."
  ],
  "verdict": "One-sentence overall assessment"
}`;

/**
 * Stage 3: Use Claude API to score the script 0-100.
 * Fails the video (marks QUALITY_FAILED) if score < threshold (default 75).
 */
export async function qualityGate(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const threshold = config.QUALITY_THRESHOLD;

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const userPrompt = `Score the following YouTube script:\n\n${JSON.stringify(ctx.script, null, 2)}`;

  console.log(`[qualityGate] Scoring script (threshold: ${threshold})...`);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Extract text
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
  const validation = qualitySchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `Quality response validation failed: ${issues}`,
      durationMs: Date.now() - start,
    };
  }

  const { score, reasons, verdict } = validation.data;

  console.log(`[qualityGate] Score: ${score}/100 — ${verdict}`);
  for (const r of reasons) {
    console.log(`  ${r}`);
  }

  if (score < threshold) {
    const failReason = `Quality score ${score}/${threshold}: ${verdict}`;
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: {
        qualityScore: score,
        status: VideoStatus.QUALITY_FAILED,
        failReason,
      },
    });
    return {
      success: false,
      error: failReason,
      data: { score, reasons, verdict },
      durationMs: Date.now() - start,
    };
  }

  // Passed — advance to next stage
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      qualityScore: score,
      status: VideoStatus.VOICEOVER_PENDING,
    },
  });

  return {
    success: true,
    data: { score, reasons, verdict },
    durationMs: Date.now() - start,
  };
}
