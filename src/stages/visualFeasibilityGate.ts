import {
  assessVisualFeasibility, pexelsOnlySource, formatFeasibility, env,
  buildSpokenUnits, spokenCharacterCount, spokenOutlineSegments,
  CHARS_PER_SECOND, TITLE_CARD_S, runtimeRange, currentTestStage,
  prisma,
} from "@yt-pipeline/pipeline-core";
import { VideoStatus } from "@prisma/client";
import type { PipelineContext, StageResult, Script } from "@yt-pipeline/pipeline-core";

/**
 * Refuse to buy narration for a topic the stock library cannot illustrate.
 *
 * This gate is the difference between discovering a topic is unsourceable for
 * free and discovering it for 7,071 credits, which is what happened twice
 * before it existed. It runs after the script is written and validated, and
 * before any ElevenLabs budget opens, so a failure costs nothing.
 *
 * It is a candidate-pool and timing check, not a full allocation: production
 * selects against real word timestamps that do not exist until narration does.
 * What it honestly establishes is that enough distinct, relevant, non-brand-
 * risk footage exists to cover the runtime without leaning on cards, and that
 * the script will render inside the channel's length range.
 *
 * It assesses the EXACT spoken units narration will submit — not the raw
 * segments — so it cannot size a runtime from characters the voice will never
 * speak.
 */
export async function visualFeasibilityGate(ctx: PipelineContext): Promise<StageResult> {
  const start = Date.now();
  const script = ctx.script as Script | undefined;
  if (!script || !script.segments?.length) {
    return { success: false, error: "visual feasibility: no script to assess", durationMs: Date.now() - start };
  }

  const channel = "ai-doom-scroll" as const;
  const units = buildSpokenUnits(script);
  const submitChars = spokenCharacterCount(units);

  // Duration envelope, before anything is bought.
  const narrationS = submitChars / CHARS_PER_SECOND[channel];
  const videoS = narrationS + TITLE_CARD_S;
  const range = runtimeRange(channel, "LONGFORM", currentTestStage());
  if (videoS < range.minS || videoS > range.maxS) {
    const detail =
      `${submitChars} spoken chars renders ${(videoS / 60).toFixed(1)} min, outside `
      + `${(range.minS / 60).toFixed(0)}-${(range.maxS / 60).toFixed(0)} min`;
    await fail(ctx, detail);
    return { success: false, error: `visual feasibility: ${detail}`, durationMs: Date.now() - start };
  }

  const report = await assessVisualFeasibility(
    {
      channel,
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

  if (!report.pass) {
    await fail(ctx, report.failureReason ?? "feasibility failed");
    return {
      success: false,
      error: `visual feasibility FAILED — no narration purchased: ${report.failureReason}`,
      durationMs: Date.now() - start,
    };
  }

  console.log(
    `[visualFeasibilityGate] PASS — ${report.uniqueUsableAssets} unique usable assets `
    + `(${report.uniqueUsableAssetsExcludingBrandRisk} without brand risk), `
    + `${report.totalUsableDurationS}s usable, ${report.estimatedCardPct}% predicted cards, `
    + `${submitChars} chars will be submitted`,
  );
  return { success: true, durationMs: Date.now() - start };
}

/**
 * A gated failure is terminal, not something a resumer picks up later.
 *
 * QUALITY_FAILED sits outside RESUMABLE_STATUSES, so an unsourceable topic
 * stops here and waits for a human rather than being retried into a spend.
 */
async function fail(ctx: PipelineContext, reason: string): Promise<void> {
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      status: VideoStatus.QUALITY_FAILED,
      failReason: `[VISUAL_FEASIBILITY] ${reason}`.slice(0, 1000),
    },
  });
  console.error(`[visualFeasibilityGate] BLOCKED before spend: ${reason}`);
}
