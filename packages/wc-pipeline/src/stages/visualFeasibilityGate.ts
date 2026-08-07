import { VideoStatus } from "@prisma/client";
import {
  prisma, env,
  assessVisualFeasibility, pexelsOnlySource, formatFeasibility,
  buildSpokenUnits, spokenCharacterCount, spokenOutlineSegments,
  CHARS_PER_SECOND, TITLE_CARD_S, runtimeRange, currentTestStage,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult, Script } from "@yt-pipeline/pipeline-core";
import { tieAwareConceptAccounting, tieAwareChecks } from "./conceptAccounting";
import { longestNoNewConceptRun } from "./monotonyDiagnostics";

const CHANNEL = "wet-circuit" as const;
const LOG = "[wc:visualFeasibilityGate]";

/**
 * Refuse to buy narration for a topic the stock library cannot illustrate.
 *
 * This is the difference between discovering a topic is unsourceable for free
 * and discovering it for thousands of credits. It runs after the script is
 * written and validated and before any ElevenLabs budget opens, so a failure
 * costs nothing.
 *
 * It is a candidate-pool and timing check, not a full allocation: production
 * selects against real word timestamps that do not exist until narration does.
 * What it honestly establishes is that enough distinct, relevant, non-brand-
 * risk footage exists to cover the runtime without leaning on cards, and that
 * the script will render inside Wet Circuit's length range.
 *
 * It assesses the EXACT spoken units narration will submit — not the raw
 * segments — so it cannot size a runtime from characters the voice will never
 * speak.
 *
 * This is Wet Circuit's own copy. AI Doom Scroll has its own gate at
 * src/stages/visualFeasibilityGate.ts and does not import this module: the two
 * channels are deliberately not coupled, so a change here can never alter AI
 * Doom's behaviour.
 */

export interface FeasibilityEnvelope {
  submitChars: number;
  narrationS: number;
  videoS: number;
}

/**
 * Duration envelope from the exact spoken text.
 *
 * Exported so a dry run can obtain the same numbers without a video row to
 * fail, and so tests can assert on it directly.
 */
export function wcDurationEnvelope(script: Script): FeasibilityEnvelope {
  const submitChars = spokenCharacterCount(buildSpokenUnits(script));
  const narrationS = submitChars / CHARS_PER_SECOND[CHANNEL];
  return { submitChars, narrationS, videoS: narrationS + TITLE_CARD_S };
}

export async function wcVisualFeasibilityGate(ctx: PipelineContext): Promise<StageResult> {
  const start = Date.now();
  const script = ctx.script as Script | undefined;
  if (!script || !script.segments?.length) {
    return {
      success: false,
      error: "visual feasibility: no script to assess",
      durationMs: Date.now() - start,
    };
  }

  const { submitChars, videoS } = wcDurationEnvelope(script);

  // Duration envelope, before anything is bought.
  const range = runtimeRange(CHANNEL, "LONGFORM", currentTestStage());
  if (videoS < range.minS || videoS > range.maxS) {
    const detail =
      `${submitChars} spoken chars renders ${(videoS / 60).toFixed(1)} min, outside `
      + `${(range.minS / 60).toFixed(1)}-${(range.maxS / 60).toFixed(1)} min`;
    await failCandidate(ctx.video.id, detail);
    return {
      success: false,
      error: `visual feasibility: ${detail}`,
      durationMs: Date.now() - start,
    };
  }

  const report = await assessVisualFeasibility(
    {
      channel: CHANNEL,
      topicTitle: ctx.topic.title,
      targetRuntimeS: Math.round(videoS),
      // Byte-identical to what narration will submit.
      segments: spokenOutlineSegments(script).map((s) => ({
        segmentIndex: s.segmentIndex,
        title: s.title,
        narration: s.narration,
        visual_prompt: s.visual_prompt,
      })),
    },
    pexelsOnlySource(env().PEXELS_API_KEY),
  );
  console.log(formatFeasibility(report));

  // Concept concentration is re-evaluated with tie-aware accounting. The
  // shared gate files a tie as "none", which reported genuinely marine
  // footage as an unnameable subject; here a tie is divided between the
  // concepts that tied. Every other check, and the entire allocation, is the
  // gate's own — only the labelling of already-allocated seconds changes.
  const accounting = tieAwareConceptAccounting(report);
  const checks = tieAwareChecks(report, accounting);
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `${LOG} tie-aware concepts: ` +
    Object.entries(accounting.conceptShares)
      .sort((a, b) => b[1] - a[1])
      .map(([c, s]) => `${c}=${(s * 100).toFixed(1)}%`)
      .join(" ") +
    ` | genuine none ${(accounting.genuineNoneShare * 100).toFixed(1)}%` +
    ` | ${accounting.distinctConcreteConcepts} concrete`,
  );
  for (const c of failed) console.log(`${LOG}   ✗ ${c.name}: ${c.detail}`);

  // Measurement only — logged for comparison, never consulted for the verdict.
  const run = longestNoNewConceptRun(accounting.fragments);
  if (run) {
    console.log(
      `${LOG} [diagnostic, not a gate] longest no-new-concept run ` +
      `${run.seconds.toFixed(1)}s (${(run.shareOfTimeline * 100).toFixed(1)}% of timeline), ` +
      `fragments ${run.startFragmentIndex}-${run.endFragmentIndex}, ` +
      `vocabulary [${run.initialConcreteConcepts.join(", ") || "none"}], ` +
      `${run.uniqueAssetCount} assets`,
    );
  }

  if (failed.length > 0) {
    const reason = failed.map((c) => `${c.name}: ${c.detail}`).join("; ");
    await failCandidate(ctx.video.id, reason);
    return {
      success: false,
      error: `visual feasibility FAILED — no narration purchased: ${reason}`,
      durationMs: Date.now() - start,
    };
  }

  console.log(
    `${LOG} PASS — ${report.uniqueUsableAssets} unique usable assets `
    + `(${report.uniqueUsableAssetsExcludingBrandRisk} without brand risk), `
    + `${report.totalUsableDurationS}s usable, ${report.estimatedCardPct}% predicted cards, `
    + `${submitChars} chars will be submitted`,
  );
  return { success: true, durationMs: Date.now() - start };
}

/**
 * A gated failure is terminal, not something a resumer picks up later.
 *
 * QUALITY_FAILED sits outside RESUME_FROM, so an unsourceable topic stops here
 * and waits for a human rather than being retried into a spend.
 */
async function failCandidate(videoId: string, reason: string): Promise<void> {
  await prisma.wcVideo.update({
    where: { id: videoId },
    data: {
      status: VideoStatus.QUALITY_FAILED,
      failReason: `[VISUAL_FEASIBILITY] ${reason}`.slice(0, 1000),
    },
  });
  console.error(`${LOG} BLOCKED before spend: ${reason}`);
}
