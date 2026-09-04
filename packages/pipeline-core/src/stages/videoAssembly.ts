import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { currentTestStage } from "../lib/testStage";
import { currentPilot } from "../lib/pilot";
import { currentTranche } from "../lib/productionTrancheStore";
import { runAssembly } from "./assemblyShared";
import type { PipelineContext, StageResult } from "../types";

export { TITLE_CARD_DURATION, DURATION_TOLERANCE, cleanupAssemblyTmp } from "./assemblyShared";
export type { AssemblyOutcome } from "./assemblyShared";

/**
 * Whether this run is KNOWN not to make a Short.
 *
 * Mirrors the stage gate in `src/pipeline.ts` — a pilot never makes Shorts, and
 * ordinary production makes them only when its tranche says so — with one
 * deliberate difference: this returns `undefined` where the stage gate returns
 * `false`.
 *
 * The stage gate must fail CLOSED, because running shortsGenerator without
 * authority spends and uploads. This gate must fail OPEN, because its only
 * effect is whether an input file exists. So "no tranche", "pilot-governed" and
 * "could not tell" all decline to answer, and the encode happens as it always
 * has. Only a live tranche that positively says Shorts are off suppresses it.
 */
async function knownNoShort(): Promise<boolean | undefined> {
  try {
    // A pilot never makes Shorts, but pilots are the Wet Circuit canary shape
    // and the qualification path. Nothing about this run is worth optimising.
    if (await currentPilot()) return undefined;
    const tranche = await currentTranche("ai-doom-scroll");
    if (!tranche) return undefined;
    return tranche.shortsEnabled;
  } catch {
    // An unreadable authority is an unknown one.
    return undefined;
  }
}

/**
 * AI Doom Scroll video assembly.
 *
 * Delegates to the shared implementation, which builds the timeline from the
 * narration manifest (exact decoded segment offsets) and the ElevenLabs
 * character alignments, rather than from MP3 header estimates.
 */
export async function videoAssembly(ctx: PipelineContext): Promise<StageResult> {
  return runAssembly(ctx, {
    channel: "ai-doom-scroll",
    label: "assembly",
    testStage: currentTestStage(),
    shortsEnabled: await knownNoShort(),
    getVideo: (id) => prisma.video.findUnique({ where: { id } }),
    updateVideo: (id, data) =>
      prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id, status) =>
      prisma.video.update({ where: { id }, data: { status: status as VideoStatus } }),
  });
}
