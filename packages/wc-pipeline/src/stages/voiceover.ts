import { VideoStatus } from "@prisma/client";
import {
  prisma, runVoiceover, currentTestStage,
  currentPilot, withBudgetWindow,
  buildSpokenUnits, spokenCharacterCount,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult, Script } from "@yt-pipeline/pipeline-core";

/**
 * Wet Circuit voiceover stage.
 *
 * Same shared implementation as AI Doom Scroll, writing to wc_video. Voice and
 * model come from this service's own env, so the two channels keep distinct
 * voices.
 *
 * Under a pilot the narration runs inside a request-scoped budget window opened
 * to exactly the characters this candidate will submit, and closed again in a
 * `finally` whatever happens. A (channel, stage) limit is otherwise a
 * stage-wide allowance that ANY candidate may consume in full; the window makes
 * the budget per-candidate and finite, and it is scoped to the wet-circuit row
 * so a WC canary cannot draw on the AI Doom allowance.
 */
export async function wcVoiceover(ctx: PipelineContext): Promise<StageResult> {
  const testStage = currentTestStage();
  const deps = {
    channel: "wet-circuit" as const,
    label: "wc:voiceover",
    testStage,
    updateVideo: (id: string, data: Record<string, unknown>) =>
      prisma.wcVideo.update({ where: { id }, data: data as never }),
    setStatus: (id: string, status: string) =>
      prisma.wcVideo.update({
        where: { id },
        data: { status: status as VideoStatus },
      }),
  };

  const pilot = await currentPilot();
  const script = ctx.script as Script | undefined;
  if (!pilot || !script?.segments?.length) {
    return runVoiceover(ctx, deps);
  }

  // Exactly the bytes ElevenLabs will be asked to speak — not raw segment
  // text, which omits a folded hook and CTA and would under-open the window.
  const submitChars = spokenCharacterCount(buildSpokenUnits(script));
  console.log(
    `[wc:voiceover] pilot ${pilot.pilotId}: opening a ${submitChars}-char window ` +
    `on wet-circuit/${testStage}`,
  );
  return withBudgetWindow("wet-circuit", testStage, submitChars, () =>
    runVoiceover(ctx, deps),
  );
}
