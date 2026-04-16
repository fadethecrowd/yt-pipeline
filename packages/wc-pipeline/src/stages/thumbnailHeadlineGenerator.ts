import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Schema ───────────────────────────────────────────────────────────────

const responseSchema = z.object({
  thumbnailHeadline: z.string().min(1),
  thumbnailSubtext: z.string().optional().nullable(),
});

// ── Sanitizers (identical shape to AI Doom — both channels enforce the
//    same output-format rules) ────────────────────────────────────────────

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

const SYSTEM_PROMPT = `You write YouTube thumbnail text for Wet Circuit — a marine electronics
channel covering fishfinders, chartplotters, sonar/livescope, trolling
motors, batteries, wiring, power systems, and real-world boating tech.

You produce SHORT, URGENT, HIGH-CTR text — never full sentences.
Prioritize PHYSICAL, MECHANICAL, CONSEQUENTIAL framing over descriptive
accuracy. Readers should feel a part, a system, or a component doing
something visceral (breaking, failing, leaking, melting).

Use this four-step process internally:

STEP 1 — Identify the single most surprising or unusual action in the
topic. Look especially for:
- A component failing (battery, wire, seal, transducer, pump)
- One technology beating or killing another (lithium vs AGM, MEGA
  Live vs LiveScope, sidescan vs chirp)
- Something installed wrong and breaking in the field
- A cheap part letting water in / melting / shorting

STEP 2 — Use a strong PHYSICAL/MECHANICAL action verb for that action.
Preferred verbs (use when plausible):
  FAILS, BREAKS, KILLS, MELTS, LEAKS, CRACKS, BURNS, SHORTS,
  DRAINS, OVERHEATS, CORRODES, FLOODS, SNAPS, RUSTS, SEIZES
Other strong verbs that work:
  KILLS, BEATS, BURNS OUT, DIES, FRIES, GIVES UP, SINKS
AVOID weak/abstract verbs: KNOWS, HELPS, IMPROVES, ENABLES, SUPPORTS,
  PROVIDES, OFFERS, ALLOWS.

STEP 3 — Structure as three logical parts:
  SUBJECT — the failing/winning component (e.g. BATTERY, CHEAP PUMP,
            LITHIUM, THIS WIRE, BAD SEAL, MEGA LIVE)
  ACTION  — the strong physical verb
  OBJECT  — optional, what is affected (e.g. FIRST, AGM, EVERYTHING,
            YOUR RIG, AT 50 FEET)
Output them joined by spaces. Target-shape examples:
  BATTERY FAILS FIRST
  CHEAP PUMP BREAKS
  LITHIUM KILLS AGM
  THIS WIRE MELTS
  BAD SEAL LEAKS
  MEGA LIVE BEATS LIVESCOPE
  TRANSDUCER DIES AT 30 FEET

STEP 4 — Generate 5 candidate headlines internally, score each on
physical impact, consequential weight, and curiosity gap, then return
ONLY the highest-scoring one.

Final output constraints (apply after scoring):
- 2 to 5 words total
- ALL CAPS
- No punctuation, no commas, no quotes, no em-dashes, no periods
- No filler phrases ("here's why", "watch this first", "you won't believe")
- NEVER abstract — always tied to a physical component or action

Rules for thumbnailSubtext (optional):
- Maximum 3 words
- ALL CAPS, no punctuation
- Use only when it adds a visceral secondary cue (e.g. SALTWATER,
  OFFSHORE, DEAD BY DAY TWO, UNDER LOAD, FULL DRAW)
- Return null if you can't produce one that adds value

Respond with ONLY valid JSON: {"thumbnailHeadline": "...", "thumbnailSubtext": "..." | null}
Nothing else — do not include the candidate list or scores.`;

// ── Stage ────────────────────────────────────────────────────────────────

export async function wcThumbnailHeadlineGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  // NOTE: No DISABLE_ELEVEN guard here by design. This stage calls
  // Anthropic (LLM), not ElevenLabs. DISABLE_ELEVEN only gates:
  // voiceover, videoAssembly, youtubeUpload, shortsGenerator (plus
  // wcThumbnailGenerator's own guard on rendering).

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const topicTitle = ctx.topic.title;
  const summary = ctx.topic.summary ?? "";
  const seoTitle = ctx.seo?.title ?? "";
  const scriptHook = ctx.script?.hook ?? "";

  const userPrompt = `Topic: ${topicTitle}
${summary ? `Summary: ${summary}\n` : ""}${seoTitle ? `SEO title: ${seoTitle}\n` : ""}${scriptHook ? `Script hook: ${scriptHook}` : ""}`;

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

  console.log(`[wc:thumbnailHeadlineGenerator] headline: "${headline}"`);
  if (subtext) console.log(`[wc:thumbnailHeadlineGenerator] subtext: "${subtext}"`);

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      thumbnailHeadline: headline,
      thumbnailSubtext: subtext,
    },
  });

  return { success: true, data: { headline, subtext }, durationMs: Date.now() - start };
}
