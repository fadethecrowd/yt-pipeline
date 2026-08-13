import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { currentTestStage } from "../lib/testStage";
import { currentPilot } from "../lib/pilot";
import { withBudgetWindow } from "../lib/budget";
import { isUnattendedMode } from "../lib/unattendedGate";
import { authorizeNarrationWindow } from "../lib/narrationWindow";
import { buildSpokenUnits, spokenCharacterCount } from "../lib/spokenUnits";
import { runVoiceover } from "./voiceoverShared";
import type { PipelineContext, StageResult, Script } from "../types";

/**
 * AI Doom Scroll voiceover stage.
 *
 * Delegates to the shared implementation: ElevenLabs `/with-timestamps` per
 * segment (idempotent, credit-accounted) followed by sample-exact assembly of
 * the narration track.
 *
 * Under an authorised pilot the narration runs inside a request-scoped budget
 * window opened to exactly the characters this candidate will submit, and
 * closed again in a `finally` whatever happens — the same guarantee Wet
 * Circuit has had since its canary was built.
 *
 * Without it, AI Doom had no legitimate way to buy narration at all: the
 * controlled budget is 0 at rest, the pilot pre-flight requires it to be 0
 * before ARM, and nothing opened a window. The last supervised attempt passed
 * every quality and feasibility gate and then stopped at `reserveCredits` with
 * "requested 1001 chars, 0 remaining". That was the budget system behaving
 * correctly against an incomplete spend path.
 *
 * The window is NOT opened just because execution reached this stage.
 * `authorizeNarrationWindow` decides, refuses by default, and refuses
 * specifically for ordinary production, for a pilot that is not ACTIVE or has
 * no slot left, for unattended execution, for a script beyond the channel's
 * durable character ceiling, and whenever DISABLE_ELEVEN is set. When it
 * refuses, this falls through to exactly the previous behaviour: the budget
 * stays 0 and `reserveCredits` fails closed.
 *
 * Concurrency: a window is an absolute limit on one (channel, stage) row, so
 * two overlapping AI Doom runs could otherwise see each other's allowance.
 * They cannot overlap — `runPipeline` holds the channel's advisory lock for
 * the whole run — and Wet Circuit is isolated by writing a different row under
 * a different lock.
 *
 * Crash safety: if the process dies between opening and the `finally`, the
 * limit stays open. That is visible rather than silent — the pilot pre-flight
 * refuses to ARM while any controlled budget is non-zero, so the next attempt
 * stops until a human looks.
 */
export async function voiceover(ctx: PipelineContext): Promise<StageResult> {
  const channel = "ai-doom-scroll" as const;
  const stage = currentTestStage();
  const deps = {
    channel,
    label: "voiceover",
    testStage: stage,
    updateVideo: (id: string, data: Record<string, unknown>) =>
      prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id: string, status: string) =>
      prisma.video.update({
        where: { id },
        data: { status: status as VideoStatus },
      }),
  };

  const script = ctx.script as Script | undefined;
  // The bytes ElevenLabs will actually be asked to speak — not raw segment
  // text, which omits a folded hook and CTA and would under-open the window.
  const submitChars = script?.segments?.length
    ? spokenCharacterCount(buildSpokenUnits(script))
    : 0;

  const decision = authorizeNarrationWindow({
    channel,
    stage,
    pilot: await currentPilot(),
    submitChars,
    unattended: isUnattendedMode(),
    elevenDisabled: process.env.DISABLE_ELEVEN === "true",
  });

  if (!decision.open) {
    console.log(`[voiceover] no narration budget window: ${decision.reason}`);
    return runVoiceover(ctx, deps);
  }

  const { auth } = decision;
  console.log(
    `[voiceover] pilot ${auth.pilotId}: opening a ${auth.submitChars}-char window ` +
    `on ${channel}/${stage} (ceiling ${auth.ceilingChars})`,
  );
  return withBudgetWindow(channel, stage, auth.submitChars, () => runVoiceover(ctx, deps));
}
