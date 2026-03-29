import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma, env, createMessage } from "@yt-pipeline/pipeline-core";
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
  segments: z.array(segmentSchema).min(4).max(8),
  cta: z.string().min(1),
  estimatedTotalDuration: z.number().positive(),
});

// ── Pillar types ────────────────────────────────────────────────────────────

type Pillar = "RANKED_LIST" | "HEAD_TO_HEAD" | "NEW_OWNER" | "NEW_DROP";

// ── Channel voice ───────────────────────────────────────────────────────────

const VOICE = `You are the scriptwriter for "Wet Circuit", a marine electronics YouTube channel.

THE VOICE:
You are a gear-obsessed enthusiast who knows everything about fishfinders, chartplotters, VHF radios, trolling motors, autopilots, and boat electronics — but you talk like one of us. Not corporate, not stiff. Opinionated, direct, and genuinely excited about this stuff. You've installed transducers in the rain. You've compared units side by side on the water. You have strong opinions and you back them up.

ABSOLUTE RULES FOR ALL SCRIPTS:
- Target 6-8 minutes of spoken content (~900-1100 words of narration total across hook + segments + CTA)
- No filler: never say "in this video", "don't forget to like and subscribe" at the start, "without further ado", "let's dive in", "so without wasting time"
- Opinions stated as opinions ("I think", "in my experience"), facts stated as facts
- Use real product names, model numbers, and prices where available from the topic content
- Write for voiceover — natural spoken cadence, short sentences, occasional rhetorical questions
- Visual prompts should describe real b-roll a marine channel would have: product close-ups, on-water footage, screen recordings of sonar/plotter displays, install shots, comparison graphics
- Never make up specs, prices, or model numbers that aren't in the source material. If you don't have specifics, speak in ranges or say "check current pricing"`;

// ── Pillar-specific templates ───────────────────────────────────────────────

const PILLAR_TEMPLATES: Record<Pillar, string> = {
  RANKED_LIST: `SCRIPT FORMAT: RANKED LIST (Top 5 / Top 10)

STRUCTURE:
1. HOOK (10-15 seconds): Open with a bold claim or surprising fact. No preamble.
   Example tone: "There are fifty fishfinders on the market. Most of them are fine. Five of them are exceptional."

2. BRIEF INTRO (15 seconds max): One sentence on what you're ranking and why. Move fast.

3. RANKED ITEMS (one segment per item, 50-70 seconds each):
   For each item include:
   - Product name and approximate price range
   - Who it's for (the specific boater/angler who should buy this)
   - The ONE thing it does better than anything else in the lineup
   - One honest weakness — don't sugarcoat
   - Build toward #1. Save the best for last.

4. THE #1 PICK segment: Extra detail on why this is the winner. Be confident. Take a stance.

5. CTA: "If this helped you narrow it down, subscribe — we do this every week. Links to everything are in the description."

SEGMENT COUNT: 6-8 segments (intro + items + CTA wrap)`,

  HEAD_TO_HEAD: `SCRIPT FORMAT: HEAD TO HEAD (Brand A vs Brand B)

STRUCTURE:
1. HOOK (10-15 seconds): Frame the debate. Make it clear you WILL pick a winner.
   Example tone: "Garmin LiveScope versus Humminbird MEGA Live. Everyone has an opinion. I have data."

2. CONTENDERS INTRO (20-30 seconds): Quick intro of both products — model, price, one-sentence positioning. No fluff.

3. SPEC COMPARISON segment (60-90 seconds):
   Only the 3-4 specs that actually matter for a buyer's decision. Skip the spec-sheet padding.
   Use a "this one does X, that one does Y" cadence — not a laundry list.

4. REAL WORLD segment (60-90 seconds):
   How they actually perform where it matters. On the water. In practice. Not on paper.
   Specific scenarios: shallow water, deep drops, dock-to-dock navigation, rough conditions.

5. THE WINNER segment (45-60 seconds):
   Declare a winner. Explain why in 2-3 sentences. Don't hedge.

6. "WHO SHOULD BUY EACH" segment (30-45 seconds):
   The winner isn't right for everyone. Say who should buy the other one and why.

7. CTA: Subscribe, links in description.

SEGMENT COUNT: 5-7 segments`,

  NEW_OWNER: `SCRIPT FORMAT: NEW OWNER (Explainer / Beginner Education)

STRUCTURE:
1. HOOK (10-15 seconds): Relatability. Start with the feeling.
   Example tone: "You just bought a boat. The dealer handed you a manual thicker than a phone book. Now what?"

2. PROBLEM FRAMING segment (30-45 seconds):
   Why this question matters. What goes wrong when people skip this. Real consequences.

3. EXPLANATION segments (2-3 segments, 60-90 seconds each):
   Clear explanation with zero jargon — or jargon explained immediately in plain English.
   Build from simple to complex. Each segment should feel like "okay, that makes sense, what's next?"
   Use analogies to things people already understand.

4. PRACTICAL RECOMMENDATION segment (45-60 seconds):
   Don't just explain — tell them what to do. Specific products, specific steps, specific order of operations.
   "If I were setting up a boat from scratch today, here's exactly what I'd do."

5. CTA: "If you're new to boat electronics, we've got a whole playlist for you. Link in the description. Subscribe and you won't miss the next one."

SEGMENT COUNT: 5-7 segments`,

  NEW_DROP: `SCRIPT FORMAT: NEW DROP (New Product Announcement)

STRUCTURE:
1. HOOK (10-15 seconds): Why this announcement matters. Context, not hype.
   Example tone: "Garmin just dropped a new ECHOMAP — and the one spec change might make their competitors nervous."

2. WHAT'S NEW segment (60-90 seconds):
   Specific changes vs the previous model. Model numbers, features, specs. No vague "it's better" — say exactly what changed and by how much.

3. WHY IT MATTERS segment (45-60 seconds):
   Put it in context. Is this incremental or game-changing? How does it shift the competitive landscape?

4. WHO SHOULD UPGRADE segment (45-60 seconds):
   Be specific: "If you have the [previous model], here's whether it's worth upgrading."
   "If you've been waiting to pull the trigger on a [category], this changes the math."
   And who should wait — maybe the price will drop on the outgoing model.

5. PRICE AND AVAILABILITY segment (20-30 seconds):
   Price, when it ships, where to buy. If pricing isn't announced, say so.

6. CTA: "Subscribe for the full review when we get this unit on the water."

SEGMENT COUNT: 5-7 segments`,
};

// ── JSON response format ────────────────────────────────────────────────────

const JSON_FORMAT = `
Respond ONLY with valid JSON matching this exact structure:
{
  "hook": "attention-grabbing opening narration (10-15 seconds spoken)",
  "segments": [
    {
      "segmentIndex": 0,
      "title": "segment title",
      "narration": "voiceover text for this segment",
      "visual_prompt": "description of visuals: product shots, on-water footage, screen recordings, comparison graphics, install close-ups",
      "duration_seconds": 60
    }
  ],
  "cta": "closing call to action narration",
  "estimatedTotalDuration": 420
}

The estimatedTotalDuration should be 360-480 (6-8 minutes).
Total narration word count across hook + all segments + CTA should be 900-1100 words.`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

/**
 * Extract the pillar tag from the topic summary.
 * topicDiscovery stores it as "[RANKED_LIST] actual summary text..."
 */
function extractPillar(topic: PipelineContext["topic"]): Pillar {
  const summary = topic.summary ?? "";
  const match = summary.match(/^\[(RANKED_LIST|HEAD_TO_HEAD|NEW_OWNER|NEW_DROP)\]/);
  if (match) return match[1] as Pillar;

  // Fallback: heuristic from title
  const text = `${topic.title} ${summary}`.toLowerCase();
  if (/top \d|best \d|\d+ best|roundup/.test(text)) return "RANKED_LIST";
  if (/\bvs\b|versus|compared|comparison/.test(text)) return "HEAD_TO_HEAD";
  if (/new|launch|release|announce|first look/.test(text)) return "NEW_DROP";
  return "NEW_OWNER";
}

function buildSystemPrompt(pillar: Pillar): string {
  return `${VOICE}\n\n${PILLAR_TEMPLATES[pillar]}\n${JSON_FORMAT}`;
}

// ── Script generation ───────────────────────────────────────────────────────

/**
 * Generate a script, optionally with rewrite feedback from quality gate.
 * Exported for use by qualityGate's rewrite loop.
 */
export async function generateScript(
  anthropic: Anthropic,
  ctx: PipelineContext,
  feedback?: string,
): Promise<{ script?: Script; error?: string }> {
  const pillar = extractPillar(ctx.topic);
  const systemPrompt = buildSystemPrompt(pillar);

  const parts = [
    `Write a Wet Circuit YouTube script for this topic:`,
    ``,
    `Title: ${ctx.topic.title}`,
    `Source: ${ctx.topic.url}`,
    `Content pillar: ${pillar}`,
    ctx.topic.summary ? `Context: ${ctx.topic.summary.replace(/^\[.*?\]\s*/, "")}` : null,
    ``,
    `Use the ${pillar} template structure. Write in the Wet Circuit voice — opinionated, direct, enthusiast-to-enthusiast.`,
  ];

  if (feedback) {
    parts.push(
      ``,
      `IMPORTANT: A previous version of this script was rejected by quality review. Fix these issues:`,
      feedback,
      ``,
      `Rewrite the script addressing all of the above feedback while keeping the ${pillar} format.`,
    );
  }

  const userPrompt = parts.filter(Boolean).join("\n");

  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemPrompt,
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

// ── Stage entry point ───────────────────────────────────────────────────────

/**
 * Stage 2: Generate a pillar-specific script for marine electronics content.
 *
 * Reads the pillar tag from the topic summary (set by topicDiscovery),
 * selects the matching template (RANKED_LIST, HEAD_TO_HEAD, NEW_OWNER, NEW_DROP),
 * and generates a 6-8 minute script in the Wet Circuit voice.
 */
export async function scriptGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const pillar = extractPillar(ctx.topic);
  console.log(`[wc:scriptGenerator] Pillar: ${pillar} | Topic: "${ctx.topic.title}"`);

  const result = await generateScript(anthropic, ctx);

  if (result.error || !result.script) {
    return {
      success: false,
      error: result.error ?? "No script generated",
      durationMs: Date.now() - start,
    };
  }

  const script = result.script;
  const wordCount = countWords(script);

  console.log(
    `[wc:scriptGenerator] Generated ${script.segments.length} segments, ~${script.estimatedTotalDuration}s, ~${wordCount} words`,
  );

  // Compute hookSegment: hook narration + first segment, with timestamp range
  const TITLE_CARD_OFFSET = 4;
  const firstSeg = script.segments[0];
  const hookEndSeconds = TITLE_CARD_OFFSET + (firstSeg?.duration_seconds ?? 45);
  const hookSegment = JSON.stringify({
    text: `${script.hook} ${firstSeg?.narration ?? ""}`.trim(),
    startTime: "0:00",
    endTime: `0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`,
    segmentIndex: 0,
  });

  console.log(`[wc:scriptGenerator] hookSegment: 0:00-0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`);

  await prisma.wcVideo.update({
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

function countWords(script: Script): number {
  const allText = [
    script.hook,
    ...script.segments.map((s) => s.narration),
    script.cta,
  ].join(" ");
  return allText.split(/\s+/).filter(Boolean).length;
}

export { type Anthropic };
