import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import {
  prisma, env, createMessage, scriptBudget, segmentBudgets, runtimeForChars,
  buildSpokenUnits, spokenCharacterCount, currentTestStage, fmtRuntime,
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
- Visual prompts describe FILMABLE STOCK FOOTAGE, not graphics or text overlays

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

  return { script: foldHookAndCtaIntoSegments(validation.data) };
}

/**
 * Where a script sits against the canonical budget.
 *
 * Deterministic, from the text, never from anything the model says about
 * itself. `spokenCharacterCount(buildSpokenUnits(script))` is the same measure
 * the runtime check and the narration ceiling use, so the generator and the
 * gate cannot disagree about the same script.
 */
export type LengthVerdict = "OK" | "OVER" | "UNDER";

export interface LengthState {
  verdict: LengthVerdict;
  spokenChars: number;
  targetChars: number;
  maxChars: number;
  minChars: number;
  ratio: number;
  detail: string;
}

export function measureLength(input: {
  spokenChars: number; targetChars: number; maxChars: number; minChars: number;
}): LengthState {
  const { spokenChars, targetChars, maxChars, minChars } = input;
  const base = { spokenChars, targetChars, maxChars, minChars };
  if (spokenChars > maxChars) {
    return { ...base, verdict: "OVER", ratio: spokenChars / maxChars,
      detail: `${spokenChars} chars is ${(((spokenChars / maxChars) - 1) * 100).toFixed(1)}% over the ${maxChars} budget` };
  }
  if (spokenChars < minChars) {
    return { ...base, verdict: "UNDER", ratio: spokenChars / minChars,
      detail: `${spokenChars} chars is ${((1 - (spokenChars / minChars)) * 100).toFixed(1)}% under the ${minChars} minimum` };
  }
  return { ...base, verdict: "OK", ratio: spokenChars / targetChars,
    detail: `${spokenChars} chars is inside ${minChars}-${maxChars}` };
}

/**
 * How many repair actions one candidate may spend on length. Two: a targeted
 * rewrite of the existing script, then one regeneration to the same explicit
 * budgets if that was not enough.
 *
 * There was previously a rule that anything more than 15% over could not be
 * repaired at all, so a 22%-over script went straight to the gates and died.
 * That threshold was asserted, never measured. A 23% reduction is a compression
 * job — the same six segments, less padding — not a different story, and the
 * honest way to find out is to attempt it and then COUNT. The bound that
 * matters is the number of attempts, not a guess about which ones are winnable.
 */
export const MAX_LENGTH_REPAIRS = 2;

function segmentReport(script: Script, budgets: { index: number; targetChars: number; maxChars: number }[]): string {
  return script.segments.map((seg, i) => {
    const b = budgets[i];
    const n = spokenCharacterCount(buildSpokenUnits({ ...script, segments: [seg], hook: "", cta: "" } as Script));
    return `  segment ${i}: ${n}${b ? ` / ${b.targetChars} / ${b.maxChars}` : ""}`;
  }).join("\n");
}

/**
 * Rewrite the SAME script to fit, or expand it to reach the floor.
 *
 * Given the exact numbers on both sides — total and per segment — so the model
 * is editing against arithmetic rather than an adjective. Preserves the claims,
 * the structure and the visual prompts; only narration changes.
 */
async function repairScriptLength(
  anthropic: Anthropic,
  script: Script,
  state: LengthState,
  budgets: { index: number; targetChars: number; maxChars: number }[],
): Promise<{ script?: Script; error?: string }> {
  const over = state.verdict === "OVER";
  const delta = Math.abs(state.spokenChars - state.targetChars);
  const prompt = `This video script is ${over ? "too long" : "too short"} and must be ${over ? "shortened" : "expanded"}. It is otherwise good — do not rewrite it.

CURRENT TOTAL: ${state.spokenChars} spoken characters
TARGET TOTAL:  ${state.targetChars} spoken characters (aim here)
HARD MAXIMUM:  ${state.maxChars}
HARD MINIMUM:  ${state.minChars}

You must ${over ? "cut" : "add"} approximately ${delta} characters of narration.

PER-SEGMENT BUDGET (current / target / max):
${segmentReport(script, budgets)}

RULES:
- ${over ? "Shorten. Do NOT add material." : "Expand only by developing points already present."}
- Do NOT introduce any new claim, fact, number or example.
- Keep the hook's opening line intact.
- Keep every distinct technical point and every concrete example.
- Keep the CTA${over ? ", tightened" : ""}.
- Keep the same number of segments and the same segment titles.
- Keep every visual_prompt exactly as it is.
- ${over
    ? "Cut by removing repetition, filler, repeated setup and verbose transitions — not by deleting substance."
    : "Expand by developing the existing points more fully — not by padding with filler."}
- Bring EACH segment within its per-segment budget above.

Return the SAME JSON shape you were given, with only the narration fields changed.

SCRIPT:
${JSON.stringify({ hook: script.hook, cta: script.cta, segments: script.segments.map((x) => ({
    segmentIndex: x.segmentIndex, title: x.title, narration: x.narration,
    visual_prompt: x.visual_prompt, duration_seconds: x.duration_seconds,
  })), estimatedTotalDuration: script.estimatedTotalDuration }, null, 2)}`;

  const raw = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = raw.content.find((c) => c.type === "text");
  if (!text || text.type !== "text") return { error: "length repair returned no text" };
  const jsonMatch = /\{[\s\S]*\}/.exec(text.text);
  if (!jsonMatch) return { error: "length repair returned no JSON" };
  let parsed: unknown;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { return { error: `length repair JSON invalid: ${e instanceof Error ? e.message : String(e)}` }; }
  const v = scriptSchema.safeParse(parsed);
  if (!v.success) {
    return { error: `repaired script failed validation: ${
      v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  return { script: foldHookAndCtaIntoSegments(v.data) };
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

  // ── Bounded length repair, before anything downstream ─────────────
  //
  // The model does not reliably obey a length budget: the first production
  // candidate came back 4.3% over, the second 22%. Both were refused by the
  // runtime check having already paid for a quality judgement on a script that
  // could never ship. So length is settled HERE, deterministically, before
  // qualityGate sees anything.
  //
  // Two repair actions, no more: rewrite the same script to fit, then — if
  // that still misses — one regeneration against the same explicit per-segment
  // budgets. Every step re-COUNTS from the text rather than believing either
  // the model or the previous step. Same candidate, same run, same tranche
  // attempt throughout; nothing here can claim a slot or spend anything.
  {
    const b = productionBudget();
    const budgets = segmentBudgets(b, script.segments.length);
    const measure = (sc: Script) => measureLength({
      spokenChars: spokenCharacterCount(buildSpokenUnits(sc)),
      targetChars: b.targetChars, maxChars: b.maxChars, minChars: b.minChars,
    });

    let state = measure(script);
    console.log(`[scriptGenerator] length: ${state.detail}\n${segmentReport(script, budgets)}`);

    for (let attempt = 1; attempt <= MAX_LENGTH_REPAIRS && state.verdict !== "OK"; attempt++) {
      const kind = attempt === 1 ? "repair" : "regeneration";
      console.log(`[scriptGenerator] length ${kind} ${attempt}/${MAX_LENGTH_REPAIRS}: ${state.detail}`);
      const next = attempt === 1
        ? await repairScriptLength(anthropic, script, state, budgets)
        // The second action regenerates from the same topic and the same
        // budgets rather than editing again — a script that survived one
        // targeted rewrite and is still outside the envelope is usually
        // structurally too big, not merely padded.
        : await generateScript(anthropic, ctx);
      if (next.error || !next.script) {
        console.log(`[scriptGenerator] length ${kind} failed: ${next.error ?? "no script"}`);
        continue;
      }
      script = next.script;
      state = measure(script);
      console.log(`[scriptGenerator] after ${kind}: ${state.detail}\n${segmentReport(script, budgets)}`);
    }

    if (state.verdict !== "OK") {
      // Terminal for this candidate. It consumed its tranche attempt, and no
      // further repair, regeneration or replacement candidate is available
      // without a fresh human authorization.
      return {
        success: false,
        error: `script length outside the production envelope after ${MAX_LENGTH_REPAIRS} ` +
          `repair attempt(s): ${state.detail}`,
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
