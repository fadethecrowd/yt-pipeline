import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Schema ───────────────────────────────────────────────────────────────

const responseSchema = z.object({
  thumbnailHeadline: z.string().min(1),
  thumbnailSubtext: z.string().optional().nullable(),
});

// ── Sanitizers ───────────────────────────────────────────────────────────

/**
 * Strip punctuation, collapse whitespace, uppercase, enforce 2-5 word cap.
 * Returns null if the result has fewer than 2 words.
 */
function sanitizeHeadline(raw: string): string | null {
  const cleaned = raw
    .replace(/["'""]/g, "")
    .replace(/[,—–\-:;.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length < 2) return null;
  return words.slice(0, 5).join(" ");
}

/**
 * Same cleanup, but optional and capped at 3 words.
 */
function sanitizeSubtext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/["'""]/g, "")
    .replace(/[,—–\-:;.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.slice(0, 3).join(" ");
}

// ── Prompt ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write YouTube thumbnail text for an AI/tech doom-scroll channel.
You produce SHORT, URGENT, HIGH-CTR text — never full sentences.

Rules for thumbnailHeadline:
- 2 to 5 words
- ALL CAPS
- No punctuation, no commas, no quotes, no em-dashes, no periods
- No filler phrases like "here's why", "watch this first", "you won't believe"
- Punchy, urgent, high-impact

Examples of strong style:
- CLAUDE GOT A LEASH
- OPENAI BUILT A KILL SWITCH
- GOOGLE IS WATCHING
- AGENTS BROKE PROD
- MODEL FAILED

Rules for thumbnailSubtext (optional):
- Maximum 3 words
- ALL CAPS, no punctuation
- Use only when it adds an urgent secondary cue (e.g. PRODUCTION, AGAIN, REAL WORLD, FULL CONTROL)
- Return null if you can't produce one that adds value

Respond with ONLY valid JSON: {"thumbnailHeadline": "...", "thumbnailSubtext": "..." | null}
Nothing else.`;

// ── Stage ────────────────────────────────────────────────────────────────

export async function thumbnailHeadlineGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[guard] DISABLE_ELEVEN active — skipping thumbnail headline generation");
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: {
        thumbnailHeadline: "DRY RUN",
        thumbnailSubtext: "TEST",
      },
    });
    return { success: true, durationMs: Date.now() - start };
  }

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const topicTitle = ctx.topic.title;
  const summary = ctx.topic.summary ?? "";
  const scriptHook = ctx.script?.hook ?? "";

  const userPrompt = `Topic: ${topicTitle}
${summary ? `Summary: ${summary}\n` : ""}${scriptHook ? `Script hook: ${scriptHook}` : ""}`;

  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let parsed: unknown;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON object in response");
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse Claude JSON: ${err instanceof Error ? err.message : err}. Raw: ${text.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }

  const validation = responseSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `Schema validation failed: ${validation.error.issues.map((i) => i.message).join("; ")}`,
      durationMs: Date.now() - start,
    };
  }

  const headline = sanitizeHeadline(validation.data.thumbnailHeadline);
  const subtext = sanitizeSubtext(validation.data.thumbnailSubtext);

  if (!headline) {
    return {
      success: false,
      error: `Sanitized headline is empty (raw: "${validation.data.thumbnailHeadline}")`,
      durationMs: Date.now() - start,
    };
  }

  console.log(`[thumbnailHeadlineGenerator] headline: "${headline}"`);
  if (subtext) console.log(`[thumbnailHeadlineGenerator] subtext: "${subtext}"`);

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      thumbnailHeadline: headline,
      thumbnailSubtext: subtext,
    },
  });

  return { success: true, data: { headline, subtext }, durationMs: Date.now() - start };
}
