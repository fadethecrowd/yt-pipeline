/**
 * Who is watching a pilot run — and therefore whether the clock has to.
 *
 * The pilot controls carried a time-of-day window (Mon/Wed/Fri 17:00-20:00
 * America/New_York) that existed to bound *unsupervised* risk: if something
 * could start on its own, it should at least only be able to start while a
 * person was likely around. That reasoning never applied to the manual
 * controls, which cannot start anything without a human running a command with
 * an explicit acknowledgement flag in the same shell.
 *
 * For a manually supervised attempt the real contract is the one the operator
 * actually enforces, and none of it is a clock:
 *
 *   1. explicit human authorization for this specific run
 *   2. exactly one bounded attempt
 *   3. guarded ElevenLabs spend, opened per candidate and relocked after
 *   4. immediate relock of the pipeline once the attempt ends
 *   5. human review before the success cap advances or another video is made
 *   6. no unattended execution
 *   7. no scheduler side door
 *   8. normal quality and safety gates still fail closed
 *
 * So the window is waived for MANUAL_SUPERVISED and kept for UNATTENDED.
 *
 * `UNATTENDED` is the DEFAULT everywhere this type is optional, which is the
 * whole point of naming it. This repository has twice shipped a bug where an
 * absent environment variable silently selected a policy, and both times the
 * fallback happened to be the stricter one and hid the defect. Here the
 * fallback is deliberately the restrictive branch: a caller that forgets to
 * say it is supervised gets the clock, not a waiver. Permission has to be
 * stated, never inferred from something being missing.
 *
 * This does NOT touch unattended production scheduling. That path is gated
 * independently by `PRODUCTION_MODE=unattended`, a durable `production_cycle`
 * row, and the scheduler's own publication-slot policy (Mon/Wed/Fri 15:00 ET,
 * authorized 1-6h ahead). None of those read this type.
 */

/** Whether a human is driving this specific run. */
export type PilotSupervision = "MANUAL_SUPERVISED" | "UNATTENDED";

/**
 * A human ran a control command, in a shell, with an acknowledgement flag.
 * Only the manual pilot/canary control scripts and the code paths reachable
 * *only* from them may pass this.
 */
export const MANUAL_SUPERVISED: PilotSupervision = "MANUAL_SUPERVISED";

/** Anything that could have started without a person present. */
export const UNATTENDED: PilotSupervision = "UNATTENDED";

/**
 * True when the time-of-day window still has to be evaluated.
 *
 * Written as an explicit equality against MANUAL_SUPERVISED rather than
 * `!== UNATTENDED`, so a future third supervision mode enforces the window
 * until someone deliberately decides otherwise.
 */
export function windowApplies(supervision: PilotSupervision): boolean {
  return supervision !== MANUAL_SUPERVISED;
}
