import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import { prisma, env, createMessage, normalize } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, StageResult } from "@yt-pipeline/pipeline-core";
import { generateScript } from "./scriptGenerator";

const MAX_REWRITES = 2; // up to 2 rewrite attempts after initial failure

// ── Zod schema for Claude's scoring output ─────────────────────────────────

const qualitySchema = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()).min(1),
  verdict: z.string().min(1),
});

export type QualityResult = z.infer<typeof qualitySchema>;

// ── System prompt ──────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a senior YouTube content quality reviewer for an AI/tech news channel.
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

// ── Scoring payload ────────────────────────────────────────────────────────

/**
 * What the scorer is shown, and why it is not the raw script object.
 *
 * Since the Aug 2026 fold reorder, `foldHookAndCtaIntoSegments` is the LAST
 * transformation and the single origin of hook and CTA text: it prepends the
 * hook into `segments[0].narration` and appends the CTA to the last one, while
 * leaving `script.hook` and `script.cta` in place as the fields it copied FROM.
 * That is the designed shape — `validateScriptStructure` calls containing the
 * part exactly once "the designed state" — and `buildSpokenUnits` narrates each
 * segment once, so the audio says the hook once.
 *
 * Serialising that object whole showed the scorer the hook twice: once as a
 * top-level field and again at the head of segment 0. Run 292d7cd2 scored 79
 * and deducted on two dimensions for an opening "repeated verbatim as the first
 * segment narration" — a repeat that is real in the JSON and absent from the
 * audio. The model was reading the payload correctly; the payload was wrong.
 *
 * So the fields are dropped ONLY where the segment provably already contains
 * them, which is exactly the co-occurrence folding creates. Nothing else is
 * removed, nothing is softened, and no duplication signal is suppressed:
 *
 *   - a hook written into the body a SECOND time still appears twice inside
 *     `segments[0].narration`, and is still visible to the scorer;
 *   - a hook repeated as its own segment is untouched — it is in `segments[]`
 *     twice and is serialised twice;
 *   - an unfolded or partially-folded script fails the containment test, so the
 *     field is kept and the payload is byte-identical to the old behaviour.
 *
 * The deterministic detector is unaffected either way. `validateScriptStructure`
 * runs in scriptGenerator before this stage, is not scored, and rejects or
 * repairs every real duplication shape including the e704334a partial-overlap
 * case. This function changes what the fuzzy second opinion is asked about; it
 * does not change what the structural gate refuses.
 */
export function buildScoringPayload(script: Script): {
  json: string;
  foldedHook: boolean;
  foldedCta: boolean;
} {
  const segments = script.segments ?? [];
  const first = segments[0];
  const last = segments[segments.length - 1];
  const hook = (script.hook ?? "").trim();
  const cta = (script.cta ?? "").trim();

  const contains = (narration: string | undefined, part: string): boolean =>
    Boolean(part) && Boolean(narration) && normalize(narration!).includes(normalize(part));

  const foldedHook = contains(first?.narration, hook);
  const foldedCta = contains(last?.narration, cta);

  const view: Record<string, unknown> = { ...script };
  if (foldedHook) delete view.hook;
  if (foldedCta) delete view.cta;

  return { json: JSON.stringify(view, null, 2), foldedHook, foldedCta };
}

/**
 * Tell the scorer where the hook and CTA live once their fields are gone.
 *
 * Hook strength and CTA clarity are two of the five rubric dimensions. Removing
 * a field without saying where its content went would cost real marks on both,
 * which is the opposite of the fix.
 */
export function foldNote(foldedHook: boolean, foldedCta: boolean): string {
  if (!foldedHook && !foldedCta) return "";
  const where: string[] = [];
  if (foldedHook) {
    where.push(
      "The HOOK is the opening of segments[0].narration. It has no separate " +
      "field because it is spoken there and only there — score Hook strength " +
      "from the start of that narration.",
    );
  }
  if (foldedCta) {
    where.push(
      "The CTA is the close of the final segment's narration. It has no " +
      "separate field because it is spoken there and only there — score CTA " +
      "clarity from the end of that narration.",
    );
  }
  return (
    "NOTE ON STRUCTURE: this script is already assembled for narration. Each " +
    "segment's narration is the complete text spoken for that segment, read " +
    "exactly once.\n" + where.map((w) => `- ${w}`).join("\n") +
    "\nDo not treat the absence of a hook or cta field as a defect. Text that " +
    "genuinely appears twice in the narration below IS a defect — judge " +
    "repetition on what you can see here.\n\n"
  );
}

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

async function scoreScript(
  anthropic: Anthropic,
  script: Script,
): Promise<QualityResult | { error: string }> {
  const payload = buildScoringPayload(script);
  const note = foldNote(payload.foldedHook, payload.foldedCta);

  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Score the following YouTube script:\n\n${note}${payload.json}` }],
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

  const validation = qualitySchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { error: `Quality response validation failed: ${issues}` };
  }

  return validation.data;
}

/**
 * Stage 3: Score the script 0-100. If below threshold, feed rejection
 * reasons back to the script generator for a rewrite (up to MAX_REWRITES
 * attempts). Fails the video only after all rewrite attempts are exhausted.
 */
export async function qualityGate(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();
  const config = env();
  const threshold = config.QUALITY_THRESHOLD;
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  let currentScript = ctx.script;
  let lastScore = 0;
  let lastReasons: string[] = [];
  let lastVerdict = "";

  for (let attempt = 0; attempt <= MAX_REWRITES; attempt++) {
    const label = attempt === 0 ? "initial" : `rewrite #${attempt}`;
    console.log(`[qualityGate] Scoring script (${label}, threshold: ${threshold})...`);

    const result = await scoreScript(anthropic, currentScript);

    if ("error" in result) {
      return { success: false, error: result.error, durationMs: Date.now() - start };
    }

    lastScore = result.score;
    lastReasons = result.reasons;
    lastVerdict = result.verdict;

    console.log(`[qualityGate] Score: ${result.score}/100 — ${result.verdict}`);
    for (const r of result.reasons) {
      console.log(`  ${r}`);
    }

    if (result.score >= threshold) {
      // Passed
      await prisma.video.update({
        where: { id: ctx.video.id },
        data: {
          qualityScore: result.score,
          scriptJson: currentScript as any,
          status: VideoStatus.VOICEOVER_PENDING,
        },
      });
      ctx.script = currentScript;

      if (attempt > 0) {
        console.log(`[qualityGate] Passed after ${attempt} rewrite(s)`);
      }

      return {
        success: true,
        data: { score: result.score, reasons: result.reasons, verdict: result.verdict },
        durationMs: Date.now() - start,
      };
    }

    // Failed — attempt rewrite if we have attempts left
    if (attempt < MAX_REWRITES) {
      const feedback = result.reasons.join("\n") + "\n\nVerdict: " + result.verdict;
      console.log(`[qualityGate] Score ${result.score} < ${threshold}, requesting rewrite (attempt ${attempt + 1}/${MAX_REWRITES})...`);

      const rewrite = await generateScript(anthropic, ctx, feedback);
      if (rewrite.error || !rewrite.script) {
        console.error(`[qualityGate] Rewrite failed: ${rewrite.error}`);
        break; // fall through to failure
      }

      currentScript = rewrite.script;
      console.log(
        `[qualityGate] Rewrite generated ${currentScript.segments.length} segments, ~${currentScript.estimatedTotalDuration}s`
      );
    }
  }

  // All attempts exhausted
  const failReason = `Quality score ${lastScore}/${threshold} after ${MAX_REWRITES} rewrite(s): ${lastVerdict}`;
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      qualityScore: lastScore,
      status: VideoStatus.QUALITY_FAILED,
      failReason,
    },
  });

  return {
    success: false,
    error: failReason,
    data: { score: lastScore, reasons: lastReasons, verdict: lastVerdict },
    durationMs: Date.now() - start,
  };
}
