import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import {
  prisma, env, createMessage, scriptBudget, segmentBudgets, runtimeForChars,
  buildSpokenUnits, spokenCharacterCount, currentTestStage, fmtRuntime, trimToLimit,
  validateScriptStructure,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, StageResult } from "@yt-pipeline/pipeline-core";

const AI_DOOM_CHANNEL = "ai-doom-scroll" as const;

/** The one length contract, shared with the gate that enforces it. */
export function productionBudget() {
  return scriptBudget(AI_DOOM_CHANNEL, "LONGFORM", currentTestStage());
}

/**
 * The length budget the script must be written to.
 *
 * Derived from `scriptBudget` — the same module the downstream runtime check and
 * the narration ceiling read — rather than from an inline copy of the speech rate.
 *
 * This used to read TARGET_RUNTIME_SECONDS from the environment and, when it
 * was absent, fall back to the bare string "3-6 minutes" with no numeric budget
 * of any kind. Only `qualify.ts` and `prepare-qualification-review.ts` ever set
 * that variable, so both qualification videos got a real budget and the first
 * ordinary production run got the prose fallback. It produced 6,181 spoken
 * characters, reported "~312s total" from its own estimate, and the gate
 * measured 8.1 minutes against a 5–8 minute envelope.
 *
 * The old instruction also permitted a 20% overshoot ("do NOT exceed words ×
 * 1.2"), which is 20% of the way out of an envelope whose whole width is 60%.
 * The cap is now the budget's own `maxChars`, which already sits below the
 * gate's ceiling by the measured error in the speech rate.
 */
function lengthInstruction(): string {
  const b = productionBudget();
  const words = Math.round(b.targetChars / 6.1);
  const maxWords = Math.round(b.maxChars / 6.1);
  const segments = Math.max(4, Math.min(6, Math.round((b.targetS - 4) / 75)));
  const perSegment = Math.round(words / segments);
  return `${(b.targetS / 60).toFixed(1)} minutes.

LENGTH BUDGET — this is a hard budget, not a suggestion:
- Write exactly ${segments} body segments.
- Each segment's narration must be approximately ${perSegment} words (±15%).
- TOTAL narration across hook + all ${segments} segments + CTA must be about ${words} words (${b.targetChars} characters).
- NEVER exceed ${maxWords} words (${b.maxChars} characters) in total. A script over that budget is rejected before it is ever voiced, and the work is wasted. Going long is a failure, not thoroughness.
- Count as you write. Stop when the budget is met.

The hook and the CTA are separate dedicated fields. Write them ONCE, there.
Do NOT repeat the hook's wording at the start of segment 0, and do NOT write
CTA or outro boilerplate — "like and subscribe", "drop a comment", "I read
every comment" — into any segment body. Segment bodies carry the substance
only; the outro is added from the CTA field automatically.`;
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
- Visual prompts describe FILMABLE STOCK FOOTAGE, not graphics or text overlays

CONCRETE ANCHORS (this decides whether the footage can be RELEVANT):
- Every segment's narration must name at least one concrete, filmable thing:
  a real company or organisation, a named product or model, a specific figure
  or price, a named report or filing, or a physical piece of technology — a
  chip, a data centre, a server rack, a robot, a screen showing a real tool.
- An anchor is something a camera could be pointed at. "The H100s sitting in
  the racks" is an anchor; "AI processing power" is not. "Twenty to fifty
  percent off list price" is an anchor; "significant discounts" is not.
- NEVER INVENT ONE. Anchors come from the title, source and summary you are
  given, and nowhere else. Do not fabricate company names, figures, dates,
  prices, quotes, study titles or sources. Do not half-remember a product name:
  if you are not certain it is called that, describe it instead of naming it.
- Supplying a real company that the material never identifies is STILL
  fabrication. If the material does not say who did this, do not reach into
  your own knowledge of the field for plausible names, competitors, customers,
  labs or journals and attach them to this story. Naming a real firm that is
  merely active in the same area asserts a connection the source never made.
  The test is not "is this entity real" — it is "did the material put this
  entity in THIS story".
- You may name what the material itself points at, including who published it,
  and you may describe well-known general technology the subject obviously
  involves. You may not attribute claims, figures or involvement to anyone the
  material does not name.
- If the material genuinely supports no concrete anchor for a segment, leave
  that segment abstract. Inventing a specific is WORSE than being vague — a
  vague sentence is a weak segment, an invented fact is a false claim.
- Never refuse and never explain yourself. If the material is too thin to
  anchor, still write the best honest script it supports, with fewer anchors or
  none, and return it as JSON like any other. An abstract script is a valid
  answer here; anything that is not the JSON object is not.
- Anchors REPLACE vague wording, they do not add to it. The length budget below
  is unchanged and binding.
- Naming a real company in the NARRATION is expected and wanted. Naming one in
  a visual_prompt is not — see the last rule of VISUAL GROUNDING. Where the
  narration names a company, its visual_prompt should show the generic,
  unbranded physical form of that same thing.

VISUAL GROUNDING (this decides whether the video can actually be made):
- Every visual_prompt must name a concrete, filmable subject: a physical place,
  object, machine, person, or activity that a camera could record. "Security
  camera mounted above a supermarket aisle" is usable; "data flowing through a
  neural network" is not.
- The subject must be what the narration is literally talking about at that
  moment. Do not illustrate a sentence about shop-floor cameras with an
  engineer at a laptop.
- Prefer the real-world setting where the story physically happens — the shop,
  street, warehouse, vehicle, control room, checkpoint, clinic or factory —
  over anyone's screen.
- Spread the segments across DIFFERENT physical settings. No single kind of
  location or object may carry most of the video; if four segments would all
  be filmed in the same room, rewrite them.
- Screens, code, terminals, dashboards, server racks and abstract data
  animations are allowed ONLY where the narration is genuinely about software,
  code or infrastructure, and never as the backbone of the video. A script
  whose visuals are mostly monitors and code cannot be produced.
- Do not add an unrelated location just to look varied. Every visual must be
  something the narration actually justifies.
- Do not name or imply a real company, product, logo or branded facility.
  Describe the generic setting instead.
- Write the visual_prompt as a plain description of the shot, not as a list of
  search keywords.
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

  // Unfolded on purpose: folding is now the LAST transformation, so length
  // enforcement measures the model's actual bodies rather than bodies inflated
  // with structural text it would then trim away.
  return { script: validation.data };
}

/**
 * The model gets ONE attempt per oversized segment, and then code takes over.
 *
 * Measured live on 2026-08-16: asked to shorten a 7,342-character script
 * against a 5,925 limit, the model returned 7,904 — longer than its input. A
 * budgeted regeneration returned 6,911. Three attempts, never inside the
 * envelope, one authorized production attempt spent.
 *
 * Whole-script rewriting and regeneration are gone from the length path. A
 * single segment is a small, well-specified edit and is worth one try, because
 * a model cut usually reads better than a mechanical one. Whether it worked is
 * decided by counting, not by trusting.
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
 * Force a script inside its spoken-character budget. The model writes; this counts and cuts.
 *
 * `shorten` is injected so the production stage and its regression test run the
 * SAME code. The previous version of this logic lived inline and was only ever
 * tested through `trimToLimit` in isolation, which is exactly why the bug below
 * reached production.
 *
 * THE BUG THIS FIXES. Budgets are measured against the SPOKEN UNIT, which is
 * what ElevenLabs is billed for and what the runtime contract counts. After
 * `foldHookAndCtaIntoSegments` the unit equals the segment narration, so
 * clamping the narration clamped the right thing. But once the model rewrites a
 * segment, its text no longer contains the hook or CTA verbatim, and
 * `buildSpokenUnits` re-adds them — so the unit is the clamped narration PLUS
 * several hundred characters. Live on 2026-08-16 that produced segment 0 at
 * 1614/1090 and segment 5 at 1398/1043 with the clamp working perfectly on the
 * wrong quantity.
 *
 * So every limit here is applied to the narration MINUS the overhead the unit
 * will re-add, recomputed after each edit, and verified against the unit.
 */
export async function enforceScriptLength(
  script: Script,
  b: { targetChars: number; maxChars: number; minChars: number },
  budgets: { index: number; targetChars: number; maxChars: number }[],
  shorten: (narration: string, budget: { targetChars: number; maxChars: number }) => Promise<string | null>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const units = () => buildSpokenUnits(script).map((u) => u.text.length);
  const total = () => spokenCharacterCount(buildSpokenUnits(script));
  /**
   * What `buildSpokenUnits` adds on top of this segment's narration.
   *
   * Enforcement now runs BEFORE folding, so the narration is the model's own
   * body and the unit is that body plus the hook or CTA the unit builder
   * supplies. Measuring the difference covers the folding overhead exactly,
   * without having to predict it — and because the trim only ever touches the
   * body, the structural text can no longer be eaten to make room for itself.
   */
  const overhead = (i: number) => units()[i]! - script.segments[i]!.narration.length;
  const report = () => units()
    .map((n, i) => `  segment ${i}: ${n} / ${budgets[i]!.targetChars} / ${budgets[i]!.maxChars}`)
    .join("\n");

  console.log(`[scriptGenerator] length: ${total()} / ${b.targetChars} / ${b.maxChars}\n${report()}`);

  // 1. At most ONE model attempt per oversized segment. Best effort.
  for (let i = 0; i < script.segments.length; i++) {
    if (units()[i]! <= budgets[i]!.maxChars) continue;
    const shorter = await shorten(script.segments[i]!.narration, budgets[i]!);
    if (shorter) {
      script.segments[i]!.narration = shorter;
      console.log(`[scriptGenerator] segment ${i} rewritten once: ${units()[i]} / ${budgets[i]!.maxChars}`);
    }
  }

  // 2. Authoritative clamp. No further model calls, whatever step 1 returned —
  //    including the case where it came back longer.
  for (let i = 0; i < script.segments.length; i++) {
    const isLast = i === script.segments.length - 1;
    let removed = 0;
    // Trimming can change whether the hook/CTA are contained, which changes the
    // overhead, so recompute and re-trim. Converges in two passes; bounded at
    // four so a pathological case cannot spin.
    for (let pass = 0; pass < 4 && units()[i]! > budgets[i]!.maxChars; pass++) {
      const limit = budgets[i]!.maxChars - overhead(i);
      if (limit <= 0) break;
      const t = trimToLimit(script.segments[i]!.narration, limit, { keepLast: isLast });
      if (t.text.length === 0 || t.text === script.segments[i]!.narration) break;
      script.segments[i]!.narration = t.text;
      removed += t.removed;
    }
    if (removed > 0 || units()[i]! !== budgets[i]!.maxChars) {
      console.log(`[scriptGenerator] segment ${i} clamped: ${units()[i]} / ${budgets[i]!.maxChars}`);
    }
    // After the clamp, over-limit means OUR code is wrong, not the script.
    if (units()[i]! > budgets[i]!.maxChars) {
      return { ok: false,
        error: `INTERNAL: length enforcement failed for segment ${i} ` +
          `(${units()[i]} > ${budgets[i]!.maxChars}) — clamp did not reach its limit` };
    }
  }

  // 3. Defensive total clamp. Per-segment maxima sum to the total budget, so
  //    this should not normally fire.
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
  if (script.segments.length !== budgets.length) {
    return { ok: false,
      error: `length enforcement changed the segment count (${script.segments.length} vs ${budgets.length})` };
  }
  console.log(`[scriptGenerator] final: ${finalChars} / ${b.targetChars} / ${b.maxChars}\n${report()}`);
  return { ok: true };
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

  let script = result.script;

  {
    const b = productionBudget();
    const budgets = segmentBudgets(b, script.segments.length);
    const enforced = await enforceScriptLength(script, b, budgets,
      (narration, budget) => shortenSegment(anthropic, narration, budget));
    if (!enforced.ok) {
      return { success: false, error: enforced.error, durationMs: Date.now() - start };
    }

    // Folding is the last transformation. From here the narration is the whole
    // spoken text, and nothing downstream re-derives the hook or CTA.
    script = foldHookAndCtaIntoSegments(script);

    // Length enforcement is what CREATES the duplication it is checked for:
    // trimming a folded segment leaves only a prefix of the hook, and
    // buildSpokenUnits then re-adds the whole thing. So structure is validated
    // here — after the trim, and before the quality judge, the downstream
    // visual checks and any narration. Not scored: a sentence read twice is wrong at any score.
    const structure = validateScriptStructure(script);
    for (const i of structure.issues) {
      console.log(`[scriptGenerator] structure ${i.code}: ${i.detail}` +
        `${i.repaired ? " (repaired)" : ""}`);
    }
    if (!structure.ok) {
      return {
        success: false,
        error: `script structure rejected before spend: ${structure.rejections.join("; ")}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // The model's own `estimatedTotalDuration` is a self-report and was, on the
  // 2026-08-15 candidate, 312s for a script the gate measured at 8.1 minutes.
  // It is still logged, labelled as the model's claim, but the number that
  // matters is the one computed from the text by the same model the gate uses.
  const budget = productionBudget();
  const spokenChars = spokenCharacterCount(buildSpokenUnits(script));
  const projectedS = runtimeForChars(AI_DOOM_CHANNEL, spokenChars);
  console.log(
    `[scriptGenerator] ${script.segments.length} segments, ${spokenChars} spoken chars ` +
    `→ ${fmtRuntime(projectedS)} projected (budget ${budget.targetChars} target / ` +
    `${budget.maxChars} max, envelope ${fmtRuntime(budget.minS)}–${fmtRuntime(budget.maxS)}); ` +
    `model self-reported ~${script.estimatedTotalDuration}s`,
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
