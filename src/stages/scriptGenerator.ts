import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { PipelineContext, Script, StageResult } from "../types";

/**
 * Stage 2: Use Claude API to generate a structured script JSON.
 * Output: hook, 4-6 body segments (each with visual_prompt), CTA.
 */
export async function scriptGenerator(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  // TODO: Initialize Anthropic client
  // const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });

  // TODO: Build prompt with topic context
  // const systemPrompt = `You are a YouTube scriptwriter for an AI/tech news channel...`;
  // const userPrompt = `Write a script about: ${ctx.topic.title}\n\nSource: ${ctx.topic.url}\nSummary: ${ctx.topic.summary}`;

  // TODO: Call Claude API and parse response as Script
  // const message = await anthropic.messages.create({
  //   model: "claude-sonnet-4-20250514",
  //   max_tokens: 4096,
  //   system: systemPrompt,
  //   messages: [{ role: "user", content: userPrompt }],
  // });

  const script: Script = {
    hook: "TODO: generated hook",
    segments: [],
    cta: "TODO: generated CTA",
    estimatedTotalDuration: 0,
  };

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
