import type { TestStage } from "@prisma/client";

/**
 * Runtime targets per channel, format and test stage.
 *
 * Two sources disagree, so both are recorded here rather than silently picking
 * one:
 *
 *   AI Doom Scroll — scriptGenerator asks for "3-6 minutes"; the 25 published
 *   long-form videos run 5:08–7:53 (median 5:50). Config UNDER-states reality.
 *
 *   Wet Circuit — scriptGenerator asks for "6-8 minutes (360-480s, 900-1100
 *   words)"; the 10 published long-form videos run 3:42–5:20 (median 4:49).
 *   Config OVER-states reality; the target has never once been met.
 *
 * Qualification targets follow OBSERVED production behaviour, because that is
 * what each channel actually looks like today and what has been editorially
 * reviewed. Adopting the Wet Circuit config figure would make every
 * qualification video longer than anything the channel has ever published,
 * which is a content decision rather than a pipeline one.
 *
 * The prompt/config drift is reported to the operator instead of being papered
 * over here.
 */

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";
export type Format = "LONGFORM" | "SHORT";

export interface RuntimeRange {
  minS: number;
  maxS: number;
  /** Where a "middle of the range" asset should land. */
  midS: number;
  /** Where an "upper end of the range" asset should land. */
  upperS: number;
}

/** What each channel's scriptGenerator prompt currently asks for. */
export const CONFIGURED_RANGE: Record<ChannelKey, { minS: number; maxS: number; source: string }> = {
  "ai-doom-scroll": { minS: 180, maxS: 360, source: "src/stages/scriptGenerator.ts — 'Total video length: 3-6 minutes'" },
  "wet-circuit": { minS: 360, maxS: 480, source: "packages/wc-pipeline/.../scriptGenerator.ts — 'estimatedTotalDuration should be 360-480'" },
};

/** What each channel has actually published (measured from YouTube). */
export const OBSERVED_RANGE: Record<ChannelKey, { minS: number; maxS: number; medianS: number; n: number }> = {
  "ai-doom-scroll": { minS: 308, maxS: 473, medianS: 350, n: 23 },
  "wet-circuit": { minS: 222, maxS: 320, medianS: 289, n: 9 },
};

/** Long-form qualification targets, grounded in observed behaviour. */
const QUALIFICATION_LONGFORM: Record<ChannelKey, RuntimeRange> = {
  "ai-doom-scroll": { minS: 300, maxS: 480, midS: 360, upperS: 450 },
  "wet-circuit": { minS: 210, maxS: 340, midS: 270, upperS: 320 },
};

/** Diagnostics are deliberately short and must never define other stages. */
const DIAGNOSTIC_LONGFORM: RuntimeRange = { minS: 55, maxS: 100, midS: 75, upperS: 90 };

/**
 * YouTube Shorts must be vertical and at most 3 minutes; this pipeline targets
 * the classic sub-60s form.
 */
const SHORT_RANGE: RuntimeRange = { minS: 20, maxS: 60, midS: 40, upperS: 55 };

export class RuntimeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTargetError";
  }
}

/**
 * The runtime range an asset must fall inside.
 *
 * Diagnostic ranges are returned ONLY for TEST_STAGE=DIAGNOSTIC, so a
 * 60–90 second diagnostic default cannot leak into qualification or
 * production.
 */
export function runtimeRange(
  channel: ChannelKey,
  format: Format,
  stage: TestStage,
): RuntimeRange {
  if (format === "SHORT") return SHORT_RANGE;
  if (stage === "DIAGNOSTIC") return DIAGNOSTIC_LONGFORM;
  // QUALIFICATION, RETEST, REPEATABILITY and PRODUCTION all target real
  // channel length. There is no stage that quietly inherits the short range.
  return QUALIFICATION_LONGFORM[channel];
}

export interface RuntimeCheck {
  ok: boolean;
  actualS: number;
  range: RuntimeRange;
  detail: string;
}

export function checkRuntime(
  actualS: number,
  channel: ChannelKey,
  format: Format,
  stage: TestStage,
): RuntimeCheck {
  const range = runtimeRange(channel, format, stage);
  const ok = actualS >= range.minS && actualS <= range.maxS;
  return {
    ok,
    actualS,
    range,
    detail: ok
      ? `${fmt(actualS)} inside ${stage} ${format} range ${fmt(range.minS)}–${fmt(range.maxS)}`
      : `${fmt(actualS)} OUTSIDE ${stage} ${format} range ${fmt(range.minS)}–${fmt(range.maxS)}`,
  };
}

/**
 * Characters of narration needed to hit a target duration.
 *
 * Rates measured from the approved diagnostics rather than assumed:
 *   ai-doom-scroll — 935 chars → 72.73 s narration = 12.86 chars/s
 *   wet-circuit    — 869 chars → 57.86 s narration = 15.02 chars/s
 * The two differ because the voices differ in pace.
 */
export const CHARS_PER_SECOND: Record<ChannelKey, number> = {
  "ai-doom-scroll": 12.86,
  "wet-circuit": 15.02,
};

/** Title card sits before narration, so narration is shorter than the video. */
export const TITLE_CARD_S = 4;

export function charsForRuntime(channel: ChannelKey, targetVideoS: number): number {
  return Math.round((targetVideoS - TITLE_CARD_S) * CHARS_PER_SECOND[channel]);
}

/**
 * How optimistic `CHARS_PER_SECOND` is against real rendered videos.
 *
 * The rate was measured from a single approved diagnostic. Two full production
 * videos have since been rendered and measured end to end:
 *
 *   3wAZeMbs3nc — 5,263 chars → 424.2 s  = 12.52 chars/s  (model predicts -2.6%)
 *   KD2QDUsr0HA — 5,528 chars → 449.6 s  = 12.41 chars/s  (model predicts -3.5%)
 *
 * So the model consistently predicts a SHORTER video than reality by about
 * 3.2%. That direction matters: a script written to exactly the ceiling would
 * render past the ceiling. The gate keeps the measured rate — it is accurate
 * enough to enforce, and erring short means it under-reports overflow rather
 * than inventing it — but anything TARGETING a length must leave this much
 * room, or it is aiming at a number it will systematically miss.
 */
export const RATE_OPTIMISM = 0.032;

export interface ScriptBudget {
  /** The runtime the finished video must land inside. */
  minS: number;
  maxS: number;
  /** What the script should aim for — comfortably inside, not at the edge. */
  targetS: number;
  /** Spoken characters implied by each of those, at the channel's measured pace. */
  minChars: number;
  maxChars: number;
  targetChars: number;
  charsPerSecond: number;
}

/**
 * The one length contract for a channel, stage and format.
 *
 * Written because the pipeline had three of them. `scriptGenerator` computed
 * its own budget from an inline copy of 12.86 — but only when
 * TARGET_RUNTIME_SECONDS happened to be set, which the qualification scripts
 * did and ordinary production did not, so production fell back to the bare
 * string "3-6 minutes" with no numeric budget at all. Meanwhile the feasibility
 * gate enforced 5–8 minutes from THIS module, and the narration ceiling came
 * from `charsForRuntime`. On 2026-08-15 that produced a 6,181-character script
 * whose own generator reported "~312s total" and which the gate correctly
 * measured at 8.1 minutes.
 *
 * `maxChars` is deliberately BELOW `charsForRuntime(maxS)`: the ceiling is what
 * the gate allows, and a generator aiming at exactly the gate's limit will
 * cross it as soon as the rate errs, which it measurably does.
 */
export function scriptBudget(
  channel: ChannelKey,
  format: Format,
  stage: TestStage,
): ScriptBudget {
  const range = runtimeRange(channel, format, stage);
  const rate = CHARS_PER_SECOND[channel];
  if (!rate) {
    throw new RuntimeTargetError(`no measured speech rate for channel "${channel}"`);
  }
  // Aim at the middle of the envelope, not the top. Both published production
  // videos landed at 424 s and 450 s inside a 300–480 s range; writing toward
  // the ceiling leaves nothing for the model to overshoot into.
  const targetS = range.upperS > range.maxS ? range.midS : Math.min(range.upperS, range.maxS);
  return {
    minS: range.minS,
    maxS: range.maxS,
    targetS,
    minChars: charsForRuntime(channel, range.minS),
    maxChars: Math.floor(charsForRuntime(channel, range.maxS) * (1 - RATE_OPTIMISM)),
    targetChars: Math.floor(charsForRuntime(channel, targetS) * (1 - RATE_OPTIMISM)),
    charsPerSecond: rate,
  };
}

/** The runtime this many spoken characters will actually produce, title card included. */
export function runtimeForChars(channel: ChannelKey, chars: number): number {
  const rate = CHARS_PER_SECOND[channel];
  if (!rate) throw new RuntimeTargetError(`no measured speech rate for channel "${channel}"`);
  return chars / rate + TITLE_CARD_S;
}

export function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
