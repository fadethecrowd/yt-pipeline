import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { ScriptFailureType } from "@prisma/client";
import {
  prisma, env, createMessage,
  classifyModelResponse, promptHash, recordScriptFailure, priorAttemptsForPrompt,
  scriptBudget, segmentBudgets, currentTestStage, trimToLimit,
  buildSpokenUnits, spokenCharacterCount, validateScriptStructure,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, StageResult } from "@yt-pipeline/pipeline-core";

// ── Zod schema for Claude's JSON output ────────────────────────────────────

const segmentSchema = z.object({
  segmentIndex: z.number().int().min(0),
  title: z.string().min(1),
  narration: z.string().min(1),
  visual_prompt: z.string().min(1),
  duration_seconds: z.number().positive(),
});

/** Structured decline the system prompt invites instead of prose. */
const declineSchema = z.object({
  declined: z.literal(true),
  reason: z.enum(["OFF_TOPIC", "THIN_SOURCE"]),
  explanation: z.string().default(""),
});

/** Identical prompts are not retried past this many recorded failures. */
const MAX_ATTEMPTS_PER_PROMPT = 2;

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
- Length is set by the LENGTH BUDGET below, which is derived from what this channel actually publishes. Treat it as a hard budget.
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

/**
 * Target runtime for the script being written.
 *
 * The historical instruction asked for 6-8 minutes / 900-1100 words, but the
 * nine published Wet Circuit videos run 3:42-5:20 — the target has never been
 * met. Qualification and production runs set TARGET_RUNTIME_SECONDS so the
 * requested length matches what the channel actually publishes.
 */
function lengthInstruction(): string {
  // The default is WC's OWN envelope, not a remembered target. The previous
  // default asked for 360-480s while `visualFeasibilityGate` allows 210-340s,
  // so the prompt and the gate disagreed by roughly 40% and the model was
  // being asked to write a script the gate was guaranteed to refuse. Measured
  // over five generations, mean spoken length was 5,272 chars against a 5,046
  // ceiling and four of five aborted before spend.
  //
  // `scriptBudget` derives target and max from `runtimeRange(channel, ...)`
  // and this channel's own measured speech rate, so the instruction cannot
  // drift from the gate again. TARGET_RUNTIME_SECONDS still overrides, for
  // deliberately shorter diagnostics.
  const b = scriptBudget("wet-circuit", "LONGFORM", currentTestStage());
  const t = Number(process.env.TARGET_RUNTIME_SECONDS ?? 0) || b.targetS;
  // Measured from the approved diagnostic: 15.02 spoken characters per second.
  const chars = Math.round((t - 4) * 15.02);
  const words = Math.round(chars / 6.1);
  const segments = Math.max(4, Math.min(7, Math.round((t - 4) / 55)));
  const perSegment = Math.round(words / segments);
  return `The estimatedTotalDuration should be about ${Math.round(t)} seconds.\n\n`
    + `LENGTH BUDGET — this is a hard budget, not a suggestion:\n`
    + `- Write exactly ${segments} segments.\n`
    + `- Each segment's narration must be approximately ${perSegment} words (±15%).\n`
    + `- TOTAL narration across hook + all ${segments} segments + CTA must be ${words} words (${chars} characters).\n`
    + `- Do NOT exceed ${Math.round(words * 1.2)} words in total. Going long is a failure, not thoroughness.\n`
    + `- Count as you write. Stop when the budget is met.`;
}

// ── JSON response format ────────────────────────────────────────────────────

function jsonFormat(): string { return `
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

${lengthInstruction()}

IF YOU CANNOT WRITE THE SCRIPT:
Some topics reaching you are not marine electronics at all — Garmin's press
feed also carries aviation, automotive, motorsport and fitness news — and some
source material is too thin to write from without inventing specs. Both are
correct reasons to decline.

When that happens do NOT write prose explaining yourself. Respond with exactly
this JSON instead, so the pipeline can classify it:
{
  "declined": true,
  "reason": "OFF_TOPIC" | "THIN_SOURCE",
  "explanation": "one sentence"
}

Never invent specs, prices or model numbers to work around a thin source.
Never stretch an off-topic product into a marine angle.`; }

// ── Helpers ─────────────────────────────────────────────────────────────────

// parseJSON() was removed: parsing is now preceded by classifyModelResponse(),
// which recognises refusals, scope objections, thin-source declines and
// truncation before any JSON.parse is attempted.

// ── Hook/CTA folding ────────────────────────────────────────────────────────
//
// The voiceover stage only renders segments[].narration — script.hook and
// script.cta were generated and quality-scored but never voiced. Fold the
// hook into the first segment's narration and the CTA into the last so they
// are actually spoken, while keeping segment count, titles, visual prompts,
// and downstream subtitle/chapter timing assumptions unchanged. The hook/cta
// fields stay on the script: wcThumbnailHeadlineGenerator and seoGenerator
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
  return `${VOICE}\n\n${PILLAR_TEMPLATES[pillar]}\n${jsonFormat()}`;
}

// ── Length enforcement ──────────────────────────────────────────────────────

/**
 * Ask the model to shorten one over-long segment. Best effort, once.
 *
 * A failure here is not fatal: the authoritative clamp below runs regardless of
 * what this returns, including the case where it comes back longer.
 */
async function shortenSegment(
  anthropic: Anthropic,
  narration: string,
  budget: { targetChars: number; maxChars: number },
): Promise<string | null> {
  const prompt = `Shorten this narration segment. It is otherwise good — do not rewrite it.

CURRENT LENGTH: ${narration.length} characters
TARGET:         ${budget.targetChars} characters
HARD MAXIMUM:   ${budget.maxChars} characters

Cut approximately ${narration.length - budget.targetChars} characters.

RULES:
- Shorten only. Do NOT add anything.
- Do NOT introduce any new claim, fact, number or example.
- Keep the segment's purpose and every distinct technical point.
- Keep the opening sentence.
- Cut repetition, filler and verbose transitions.
- Return ONLY the shortened narration text. No JSON, no preamble, no quotes.

SEGMENT:
${narration}`;

  try {
    const raw = await createMessage(anthropic, {
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = raw.content.find((c) => c.type === "text");
    if (!text || text.type !== "text") return null;
    const out = text.text.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Force a script inside its spoken-character budget. The model writes; this
 * counts and cuts.
 *
 * WHY WET CIRCUIT NEEDS THIS. `visualFeasibilityGate` measures the exact spoken
 * text and refuses anything outside 210-340s before a character is bought. WC
 * had no clamp, so the only thing standing between the model's output and that
 * gate was the prompt — and the prompt asked for 6-8 minutes. Measured over
 * five generations: mean 5,272 spoken chars against a 5,046 ceiling, four of
 * five refused. Each refusal returns `success: false`, which `runStages` turns
 * into `failVideo` → status FAILED with runMode LIVE → the 24h halt guard
 * blocks every subsequent WC run until a human prefixes failReason with
 * "[ack]". So an unclamped script did not merely waste a run; it stopped the
 * pipeline.
 *
 * ORDERING. This runs BEFORE `foldHookAndCtaIntoSegments`, so the narration
 * being trimmed is the model's own body and the hook and CTA are still in their
 * own fields. `buildSpokenUnits` supplies them on top, and `overhead` measures
 * exactly what it will add, so the structural text can never be eaten to make
 * room for itself. Folding stays last — reversing that recreates the
 * e704334a class, where a trimmed folded hook left a prefix, the containment
 * check failed, and the whole hook was read a second time.
 */
export async function enforceScriptLength(
  script: Script,
  b: { targetChars: number; maxChars: number; minChars: number },
  budgets: { index: number; targetChars: number; maxChars: number }[],
  shorten: (narration: string, budget: { targetChars: number; maxChars: number }) => Promise<string | null>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const units = () => buildSpokenUnits(script).map((u) => u.text.length);
  const total = () => spokenCharacterCount(buildSpokenUnits(script));
  const overhead = (i: number) => units()[i]! - script.segments[i]!.narration.length;
  const report = () => units()
    .map((n, i) => `  segment ${i}: ${n} / ${budgets[i]!.targetChars} / ${budgets[i]!.maxChars}`)
    .join("\n");

  console.log(`[wc:scriptGenerator] length: ${total()} / ${b.targetChars} / ${b.maxChars}\n${report()}`);

  // 1. At most ONE model attempt per oversized segment. Best effort.
  for (let i = 0; i < script.segments.length; i++) {
    if (units()[i]! <= budgets[i]!.maxChars) continue;
    const shorter = await shorten(script.segments[i]!.narration, budgets[i]!);
    if (shorter) {
      script.segments[i]!.narration = shorter;
      console.log(`[wc:scriptGenerator] segment ${i} rewritten once: ${units()[i]} / ${budgets[i]!.maxChars}`);
    }
  }

  // 2. Authoritative clamp. No further model calls, whatever step 1 returned.
  for (let i = 0; i < script.segments.length; i++) {
    const isLast = i === script.segments.length - 1;
    let removed = 0;
    for (let pass = 0; pass < 4 && units()[i]! > budgets[i]!.maxChars; pass++) {
      const limit = budgets[i]!.maxChars - overhead(i);
      if (limit <= 0) break;
      const t = trimToLimit(script.segments[i]!.narration, limit, { keepLast: isLast });
      if (t.text.length === 0 || t.text === script.segments[i]!.narration) break;
      script.segments[i]!.narration = t.text;
      removed += t.removed;
    }
    if (removed > 0) {
      console.log(`[wc:scriptGenerator] segment ${i} clamped: ${units()[i]} / ${budgets[i]!.maxChars}`);
    }
    if (units()[i]! > budgets[i]!.maxChars) {
      return { ok: false,
        error: `INTERNAL: length enforcement failed for segment ${i} ` +
          `(${units()[i]} > ${budgets[i]!.maxChars}) — clamp did not reach its limit` };
    }
  }

  // 3. Defensive total clamp. Per-segment maxima sum to the budget, so this
  //    should not normally fire.
  let guard = script.segments.length * 40;
  while (total() > b.maxChars && guard-- > 0) {
    const u = units();
    let worst = 0;
    for (let i = 1; i < u.length; i++) {
      if (u[i]! - budgets[i]!.targetChars > u[worst]! - budgets[worst]!.targetChars) worst = i;
    }
    const isLast = worst === script.segments.length - 1;
    const t = trimToLimit(script.segments[worst]!.narration,
      Math.max(1, script.segments[worst]!.narration.length - 1), { keepLast: isLast });
    if (t.text.length === 0 || t.text === script.segments[worst]!.narration) break;
    script.segments[worst]!.narration = t.text;
  }

  // 4. The guarantee.
  const finalChars = total();
  if (finalChars > b.maxChars) {
    return { ok: false,
      error: `INTERNAL: script is ${finalChars} spoken chars, over the ${b.maxChars} budget, ` +
        "after every segment was clamped" };
  }
  if (finalChars < b.minChars) {
    return { ok: false,
      error: `script is below the production minimum after length enforcement: ` +
        `${finalChars} spoken chars is under ${b.minChars}` };
  }
  console.log(`[wc:scriptGenerator] final: ${finalChars} / ${b.targetChars} / ${b.maxChars}\n${report()}`);
  return { ok: true };
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
): Promise<{ script?: Script; error?: string; failureType?: ScriptFailureType }> {
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
  const hash = promptHash(systemPrompt, userPrompt);

  // Retrying an identical prompt that already produced a refusal or a scope
  // objection just spends another Anthropic call to get the same answer.
  const priorAttempts = await priorAttemptsForPrompt(hash);
  if (priorAttempts >= MAX_ATTEMPTS_PER_PROMPT) {
    const err = `Prompt already failed ${priorAttempts}x — not retrying identical request. Replace the topic.`;
    return { error: err, failureType: "OFF_TOPIC" as ScriptFailureType };
  }

  const recordAndReturn = async (
    failureType: Exclude<ScriptFailureType, "VALID">,
    detail: string,
  ) => {
    await recordScriptFailure({
      channel: "wet-circuit",
      videoId: ctx.video?.id ?? null,
      topicId: ctx.topic?.id ?? null,
      topicTitle: ctx.topic?.title ?? null,
      pillar,
      failureType,
      detail,
      promptHash: hash,
      attempt: priorAttempts + 1,
    });
    return { error: `${failureType}: ${detail.slice(0, 300)}`, failureType };
  };

  let message;
  try {
    message = await createMessage(anthropic, {
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (e) {
    return recordAndReturn("API_ERROR", e instanceof Error ? e.message : String(e));
  }

  const textBlock = message.content.find((b) => b.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "";

  // Classify BEFORE parsing — a refusal must never reach JSON.parse.
  const classified = classifyModelResponse(text, (message as any).stop_reason);
  if (classified.type !== "VALID") {
    return recordAndReturn(classified.type, classified.detail);
  }

  // Structured decline (the escape hatch the system prompt offers).
  const asDecline = declineSchema.safeParse(classified.json);
  if (asDecline.success && asDecline.data.declined) {
    return recordAndReturn(
      asDecline.data.reason,
      `Model declined via structured response: ${asDecline.data.explanation}`,
    );
  }

  const validation = scriptSchema.safeParse(classified.json);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return recordAndReturn("SCHEMA_INVALID", issues);
  }

  const script = validation.data as Script;

  // ── Length, then fold, then structure — in that order ───────────────
  //
  // Enforcement runs on the UNFOLDED script so the trim only ever touches the
  // model's own body; the hook and CTA are still in their own fields and
  // `buildSpokenUnits` accounts for them. Folding is the LAST transformation.
  const b = scriptBudget("wet-circuit", "LONGFORM", currentTestStage());
  const budgets = segmentBudgets(b, script.segments.length);
  const enforced = await enforceScriptLength(script, b, budgets,
    (narration, budget) => shortenSegment(anthropic, narration, budget));
  if (!enforced.ok) {
    // Not a model-response classification — this is our own arithmetic
    // refusing, so it is not recorded as a ScriptGenerationFailure.
    return { error: enforced.error };
  }

  const folded = foldHookAndCtaIntoSegments(script);

  // Clamping is what CREATES the duplication this checks for: trimming a
  // segment that already contained the CTA can leave a partial overlap, and
  // `buildSpokenUnits` then re-adds the whole thing — the e704334a shape. The
  // check is deterministic and unscored, because a sentence read twice is
  // wrong at any quality score. It repairs where the edit is unambiguous and
  // refuses otherwise, before anything is bought.
  const structure = validateScriptStructure(folded);
  for (const i of structure.issues) {
    console.log(`[wc:scriptGenerator] structure ${i.code}: ${i.detail}` +
      `${i.repaired ? " (repaired)" : ""}`);
  }
  if (!structure.ok) {
    return { error: `script structure rejected before spend: ${structure.rejections.join("; ")}` };
  }

  return { script: folded };
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

  // Compute hookSegment for Shorts clipping. segments[0].narration already
  // begins with the hook (folded in by generateScript), so it is the caption
  // source 1:1 with voiced audio — no unvoiced text. startTime is 0:04
  // because narration begins after the title card (audio delayed by
  // TITLE_CARD_OFFSET in videoAssembly's final mux).
  const TITLE_CARD_OFFSET = 4;
  const firstSeg = script.segments[0];
  const hookEndSeconds = TITLE_CARD_OFFSET + (firstSeg?.duration_seconds ?? 45);
  const hookSegment = JSON.stringify({
    text: (firstSeg?.narration ?? "").trim(),
    startTime: `0:0${TITLE_CARD_OFFSET}`,
    endTime: `0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`,
    segmentIndex: 0,
  });

  console.log(`[wc:scriptGenerator] hookSegment: 0:0${TITLE_CARD_OFFSET}-0:${String(Math.min(hookEndSeconds, 59)).padStart(2, "0")}`);

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
