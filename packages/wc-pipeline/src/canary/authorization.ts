import { createHash } from "node:crypto";
import {
  qualityProfile, runtimeRange, isInWindow, formatZoned, zonedParts,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, QualityProfileName, Script } from "@yt-pipeline/pipeline-core";

/**
 * The explicit, version-controlled authorization for ONE private Wet Circuit
 * canary.
 *
 * The quality-profile contract states that an asset produced under a relaxed
 * profile "should be traceable to the decision that authorised it", and that
 * profiles are opt-in per asset with no environment switch and no global
 * override. A `PILOT_ID` in the environment is not that: it names a pilot, not
 * a decision about one candidate's visuals.
 *
 * `production_pilot` already durably owns the channel, privacy, publishAt,
 * Shorts, feasibility, guarded-upload and execution-window policy. What it
 * cannot express without a schema migration is the candidate identity, the
 * script hash, the narration ceiling and the quality profile. Those live here,
 * in tracked source, so the authorising decision is reviewable in the diff and
 * cannot be edited at runtime.
 *
 * Everything is cross-checked at resolve time against the live pilot row and
 * the live candidate. Any mismatch refuses. There is no partial match.
 *
 * NOTE ON DUPLICATION: this manifest names the PROFILE, never its value. The
 * 0.60 tolerance is owned by FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY and is
 * resolved through `qualityProfile()`. The runtime envelope is likewise
 * asserted against `runtimeRange()` rather than being an independent source of
 * truth — a drift between them refuses rather than silently preferring one.
 */

export interface WcCanaryAuthorization {
  pilotId: string;
  candidateId: string;
  channel: "wet-circuit";
  channelId: string;
  scriptSha256: string;
  qualityProfileName: QualityProfileName;
  maxNarrationChars: number;
  runtimeMinS: number;
  runtimeMaxS: number;
  privacyStatus: "private";
  publishAt: null;
  maxSuccesses: number;
  assetKind: "LONGFORM";
  window: { days: number[]; startHour: number; endHour: number; timezone: string };
  /** Why this specific asset was authorised. Carried into every report. */
  rationale: string;
}

/**
 * The one authorised canary.
 *
 * Adding a second entry is a reviewable code change, which is the point: an
 * asset produced under the relaxed tolerance is traceable to this commit.
 */
export const WC_CANARY_AUTHORIZATIONS: readonly WcCanaryAuthorization[] = [
  {
    pilotId: "wet-circuit-private-canary-1",
    candidateId: "cmshxoekx0006mbnax92xyygl",
    channel: "wet-circuit",
    channelId: "UC9iJDqlrKEs0uuMeIjb9DVA",
    scriptSha256: "7681ec18117f3255c18fd912b0c79390e70bcd0ae87618c6bd711891fb4d1259",
    qualityProfileName: "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY",
    maxNarrationChars: 4164,
    runtimeMinS: 210,
    runtimeMaxS: 340,
    privacyStatus: "private",
    publishAt: null,
    maxSuccesses: 1,
    assetKind: "LONGFORM",
    // Mon/Wed/Fri, matching the historical Wet Circuit cadence and the AI Doom
    // pilot's own [1,3,5]. An earlier pass wrote Tue/Thu here on a mistaken
    // restart assumption; nothing was ever run under it.
    window: { days: [1, 3, 5], startHour: 17, endHour: 20, timezone: "America/New_York" },
    rationale:
      "One bounded private render to obtain the human visual-quality evidence the " +
      "project has never had: no Wet Circuit video has ever been human-reviewed for " +
      "final-video quality (TIER A = 0), so the 40% concept-share tolerance cannot be " +
      "validated or calibrated from history. This candidate scores 88/100 on script " +
      "quality, holds vessel at 44.2% with five concrete concepts and zero genuine-none, " +
      "and passes all seven non-concept feasibility gates. It is evaluated under the " +
      "pre-existing FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY tolerance, which relaxes ONE " +
      "aesthetic control and nothing else.",
  },
] as const;

export class WcCanaryAuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WcCanaryAuthorizationError";
  }
}

const refuse = (code: string, message: string): never => {
  throw new WcCanaryAuthorizationError(code, message);
};

/** Hash a script exactly as the preparation path recorded it. */
export function scriptSha256(script: Script): string {
  return createHash("sha256").update(JSON.stringify(script, null, 2)).digest("hex");
}

export interface ResolveInput {
  pilot: PilotConfig;
  candidateId: string;
  script: Script;
  /** Characters narration will actually submit, from spoken units. */
  submitChars: number;
}

export interface ResolvedWcCanary {
  authorization: WcCanaryAuthorization;
  qualityProfileName: QualityProfileName;
  /** Resolved from the profile — never restated in the manifest. */
  effectiveMaxConceptShare: number;
  scriptSha256: string;
  submitChars: number;
}

/**
 * Resolve the authorization for a run, or refuse.
 *
 * Fails closed on every axis: unknown pilot, unlisted candidate, script drift,
 * wrong channel, an over-ceiling narration requirement, a runtime envelope
 * that disagrees with the canonical source, a pilot whose durable policy no
 * longer matches what was authorised, or an unknown profile name.
 *
 * Returns null — NOT an error — when the pilot is simply not an authorised
 * canary. That is the ordinary case, and it means "evaluate strictly".
 */
export function resolveWcCanaryAuthorization(input: ResolveInput): ResolvedWcCanary | null {
  const auth = WC_CANARY_AUTHORIZATIONS.find((a) => a.pilotId === input.pilot.pilotId);
  if (!auth) return null; // Not an authorised canary → strict, by absence.

  // From here every mismatch refuses. A partially matching canary is not a
  // canary; silently downgrading to strict would hide a misconfiguration.
  if (auth.candidateId !== input.candidateId) {
    refuse("CANARY_WRONG_CANDIDATE",
      `pilot ${auth.pilotId} authorises candidate ${auth.candidateId}, not ${input.candidateId}`);
  }
  if (input.pilot.channel !== auth.channel || input.pilot.channelId !== auth.channelId) {
    refuse("CANARY_WRONG_CHANNEL",
      `pilot is ${input.pilot.channel}/${input.pilot.channelId}, authorised ${auth.channel}/${auth.channelId}`);
  }

  const actualHash = scriptSha256(input.script);
  if (actualHash !== auth.scriptSha256) {
    refuse("CANARY_SCRIPT_DRIFT",
      `script sha256 ${actualHash.slice(0, 16)}… does not match authorised ${auth.scriptSha256.slice(0, 16)}…`);
  }

  if (!Number.isFinite(input.submitChars) || input.submitChars <= 0) {
    refuse("CANARY_BAD_NARRATION_COUNT", `submitChars is ${input.submitChars}`);
  }
  if (input.submitChars > auth.maxNarrationChars) {
    refuse("CANARY_NARRATION_CEILING",
      `${input.submitChars} chars exceeds the authorised ceiling of ${auth.maxNarrationChars}`);
  }

  // The envelope is asserted against the canonical source, not trusted from
  // the manifest — drift between them is a configuration error, not a licence.
  const range = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
  if (range.minS !== auth.runtimeMinS || range.maxS !== auth.runtimeMaxS) {
    refuse("CANARY_RUNTIME_ENVELOPE_DRIFT",
      `runtimeRange is ${range.minS}-${range.maxS}s but the authorisation names ${auth.runtimeMinS}-${auth.runtimeMaxS}s`);
  }

  // The pilot's own durable policy must still be what was authorised.
  if (input.pilot.privacyStatus !== auth.privacyStatus) {
    refuse("CANARY_NOT_PRIVATE", `pilot privacy is ${input.pilot.privacyStatus}`);
  }
  if (input.pilot.allowPublishAt) {
    refuse("CANARY_ALLOWS_PUBLISH", `pilot ${auth.pilotId} permits a publish time`);
  }
  if (input.pilot.maxSuccesses !== auth.maxSuccesses) {
    refuse("CANARY_WRONG_CAP",
      `pilot cap is ${input.pilot.maxSuccesses}, authorised ${auth.maxSuccesses}`);
  }
  if (input.pilot.shortsEnabled) {
    refuse("CANARY_SHORTS_ENABLED", `pilot ${auth.pilotId} has Shorts enabled`);
  }
  if (!input.pilot.requireFeasibility || !input.pilot.requireGuardedUpload) {
    refuse("CANARY_CONTROLS_DISABLED",
      `pilot must require feasibility and guarded upload`);
  }
  assertPilotWindowMatches(input.pilot, auth);

  // Throws on an unknown identifier; the tolerance is the profile's own value.
  const profile = qualityProfile(auth.qualityProfileName);

  return {
    authorization: auth,
    qualityProfileName: profile.name,
    effectiveMaxConceptShare: profile.maxConceptShare,
    scriptSha256: actualHash,
    submitChars: input.submitChars,
  };
}

/** The pilot row's window must be exactly the authorised one. */
function assertPilotWindowMatches(pilot: PilotConfig, auth: WcCanaryAuthorization): void {
  const w = auth.window;
  const same =
    pilot.timezone === w.timezone &&
    pilot.windowStartHour === w.startHour &&
    pilot.windowEndHour === w.endHour &&
    pilot.windowDays.length === w.days.length &&
    [...pilot.windowDays].sort().every((d, i) => d === [...w.days].sort()[i]);
  if (!same) {
    refuse("CANARY_WINDOW_MISMATCH",
      `pilot window days=${JSON.stringify(pilot.windowDays)} ` +
      `${pilot.windowStartHour}-${pilot.windowEndHour} ${pilot.timezone} ` +
      `does not match authorised days=${JSON.stringify(w.days)} ` +
      `${w.startHour}-${w.endHour} ${w.timezone}`);
  }
}

export interface WindowDecision {
  allowed: boolean;
  nowLocal: string;
  weekday: number;
  hour: number;
  reason: string;
}

/**
 * Fail-closed execution-window guard.
 *
 * The runner previously logged a violation and continued, which made the
 * window advisory. A canary that may run at any hour is not bounded, so this
 * refuses instead — and it refuses BEFORE the candidate is touched, before any
 * budget opens, and therefore before narration, media acquisition, rendering
 * or upload can occur.
 *
 * Boundary convention is the repository's existing one, preserved deliberately:
 * `hour >= startHour && hour < endHour`, i.e. 17:00:00 through 19:59:59
 * inclusive, with 20:00 outside. Changing it here would make the pilot row and
 * the guard disagree.
 *
 * The decision is computed from the IANA zone through Intl, so the host's own
 * clock zone — UTC on Railway — cannot change the answer.
 */
export function assertWcCanaryWindow(
  now: Date,
  auth: WcCanaryAuthorization,
): WindowDecision {
  const w = auth.window;

  // Malformed configuration fails closed rather than defaulting to permissive.
  if (!Array.isArray(w.days) || w.days.length === 0) {
    refuse("CANARY_WINDOW_MALFORMED", "execution window names no days");
  }
  if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    refuse("CANARY_WINDOW_MALFORMED", `execution window has an invalid weekday: ${JSON.stringify(w.days)}`);
  }
  if (!Number.isInteger(w.startHour) || !Number.isInteger(w.endHour)
      || w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) {
    refuse("CANARY_WINDOW_MALFORMED", `execution window hours are invalid: ${w.startHour}-${w.endHour}`);
  }
  let parts: { weekday: number; hour: number };
  try {
    parts = zonedParts(now, w.timezone);
  } catch {
    return refuse("CANARY_WINDOW_MALFORMED", `unknown timezone "${w.timezone}"`);
  }

  const allowed = isInWindow(now, {
    days: w.days, startHour: w.startHour, endHour: w.endHour, timeZone: w.timezone,
  });
  const nowLocal = formatZoned(now, w.timezone);
  const decision: WindowDecision = {
    allowed,
    nowLocal,
    weekday: parts.weekday,
    hour: parts.hour,
    reason: allowed
      ? `inside the authorised window (${w.startHour}:00-${w.endHour}:00 ${w.timezone})`
      : `outside the authorised window: ${nowLocal} — allowed days ${JSON.stringify(w.days)} ` +
        `at ${w.startHour}:00-${w.endHour}:00 ${w.timezone} (end hour exclusive)`,
  };
  if (!allowed) refuse("CANARY_OUTSIDE_WINDOW", decision.reason);
  return decision;
}

/** Non-throwing form, for CHECK tooling and reporting. */
export function evaluateWcCanaryWindow(
  now: Date,
  auth: WcCanaryAuthorization,
): WindowDecision {
  try {
    return assertWcCanaryWindow(now, auth);
  } catch (e) {
    const w = auth.window;
    let weekday = -1, hour = -1, nowLocal = "(unavailable)";
    try {
      const p = zonedParts(now, w.timezone);
      weekday = p.weekday; hour = p.hour; nowLocal = formatZoned(now, w.timezone);
    } catch { /* malformed zone — reported below */ }
    return {
      allowed: false, nowLocal, weekday, hour,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The authorization for a pilot id, or undefined. Pure lookup, no checks. */
export function findWcCanaryAuthorization(pilotId: string): WcCanaryAuthorization | undefined {
  return WC_CANARY_AUTHORIZATIONS.find((a) => a.pilotId === pilotId);
}
