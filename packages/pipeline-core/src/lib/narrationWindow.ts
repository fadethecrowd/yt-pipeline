import type { TestStage } from "@prisma/client";
import type { PilotConfig } from "./pilot";
import { runtimeRange, charsForRuntime } from "./runtimeTargets";
import type { ChannelKey } from "./runtimeTargets";

/**
 * Who is allowed to open a narration budget window, and for how much.
 *
 * The controlled production budget sits at 0 at rest, which is what makes
 * "nothing can buy narration by accident" true rather than aspirational. A
 * candidate that IS authorised still needs a way to spend, so the budget is
 * opened to exactly what that candidate will submit and closed again in a
 * `finally` — see `withBudgetWindow`.
 *
 * Wet Circuit has worked this way since its canary was built. AI Doom never
 * got the same wrapper, so its pilot could pass every gate and then die at
 * `reserveCredits` with "0 remaining" — which is how the last supervised
 * attempt ended, correctly but uselessly. This is the missing half.
 *
 * The decision is a PURE function so the trust boundary can be tested without
 * a database, a network, or a real pilot. Everything it needs is passed in;
 * nothing here reads the environment or the clock.
 *
 * It refuses by default. Every `open: false` below is a case where spending
 * would be indefensible, and the list is deliberately longer than the list of
 * ways to succeed.
 */

export interface NarrationAuthorization {
  channel: ChannelKey;
  stage: TestStage;
  pilotId: string;
  /** Exactly the characters this candidate will submit — the window size. */
  submitChars: number;
  /** The durable ceiling this channel/stage may not exceed. */
  ceilingChars: number;
}

export type NarrationWindowDecision =
  | { open: true; auth: NarrationAuthorization }
  | { open: false; reason: string };

export interface NarrationWindowInput {
  channel: ChannelKey;
  stage: TestStage;
  /** The pilot governing this channel, or null for ordinary production. */
  pilot: PilotConfig | null;
  /** Characters the narration call will actually submit. */
  submitChars: number;
  /** True when this run came from the unattended gate rather than a person. */
  unattended: boolean;
  /** True when DISABLE_ELEVEN hard-blocks narration. */
  elevenDisabled: boolean;
  /**
   * Whether a supervised lease is still live for this channel/pilot/candidate.
   *
   * Optional so existing callers and Wet Circuit are unaffected, but when the
   * caller passes `false` this refuses. The AI Doom stage always passes it.
   *
   * This is the boundary the 2026-08-13 incident needed. Authorisation was
   * granted correctly and then the supervisor died; everything downstream
   * still believed it was supervised, and 5,683 characters were bought with
   * nobody watching. Re-checking at the moment of spend means a dead
   * controller stops the purchase even though the earlier checks passed.
   */
  supervised?: boolean;
  /** Why supervision failed, for the log. */
  supervisionReason?: string;
}

/**
 * The durable ceiling for one candidate.
 *
 * Derived from the channel's authorised runtime envelope rather than from
 * anything the caller supplies: a script long enough to need more characters
 * is a script outside the envelope, and the answer to that is to refuse, not
 * to widen the allowance. `visualFeasibilityGate` already refuses such a
 * script before this point; this is the second, independent statement of the
 * same bound, on the side of the system that actually spends money.
 */
export function narrationCeilingChars(channel: ChannelKey, stage: TestStage): number {
  return charsForRuntime(channel, runtimeRange(channel, "LONGFORM", stage).maxS);
}

export function authorizeNarrationWindow(
  input: NarrationWindowInput,
): NarrationWindowDecision {
  const { channel, stage, pilot, submitChars, unattended, elevenDisabled } = input;

  // Ordering matters. The hard disable is checked BEFORE anything opens, so a
  // window can never be the thing that gets narration past DISABLE_ELEVEN.
  if (elevenDisabled) {
    return { open: false, reason: "DISABLE_ELEVEN=true — narration is hard-disabled" };
  }

  // Checked before the pilot, because a live supervisor is what makes the
  // pilot's authority current rather than merely historical.
  if (input.supervised === false) {
    return {
      open: false,
      reason: `no live supervised lease — ${input.supervisionReason ?? "supervision lapsed"}`,
    };
  }

  // Ordinary production has no spend authority. This is the boundary that
  // stops the new capability becoming a side door: reaching the voiceover
  // stage is not authorisation, being a named ACTIVE pilot is.
  if (!pilot) {
    return { open: false, reason: "no pilot governs this channel — ordinary production may not open a budget" };
  }
  if (pilot.status !== "ACTIVE") {
    return { open: false, reason: `pilot ${pilot.pilotId} is ${pilot.status}, not ACTIVE` };
  }
  if (pilot.channel !== channel) {
    return { open: false, reason: `pilot ${pilot.pilotId} governs ${pilot.channel}, not ${channel}` };
  }
  // A pilot with no slot left must not buy narration for a video it may not
  // produce. The pipeline's own cap check runs earlier; this repeats it here
  // because the earlier one is not the thing holding the chequebook.
  if (pilot.maxSuccesses - pilot.successCount <= 0) {
    return {
      open: false,
      reason: `pilot ${pilot.pilotId} has no slots left (${pilot.successCount}/${pilot.maxSuccesses})`,
    };
  }

  // The scheduler must not acquire spend authority by arriving here. An
  // unattended run is refused even when a pilot is ACTIVE, which also keeps
  // the two from ever competing for one channel's budget.
  if (unattended) {
    return { open: false, reason: "unattended execution may not open a narration budget window" };
  }

  if (!Number.isFinite(submitChars) || submitChars <= 0) {
    return { open: false, reason: `submitChars ${submitChars} is not a positive finite number` };
  }
  const ceilingChars = narrationCeilingChars(channel, stage);
  if (submitChars > ceilingChars) {
    return {
      open: false,
      reason: `submitChars ${submitChars} exceeds the ${channel}/${stage} ceiling of ${ceilingChars}`,
    };
  }

  return {
    open: true,
    auth: { channel, stage, pilotId: pilot.pilotId, submitChars, ceilingChars },
  };
}
