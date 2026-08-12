import {
  prisma, activePilotId, getPilot, PilotBlockedError, isInWindow, formatZoned,
  UNATTENDED, windowApplies,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, PilotSupervision } from "@yt-pipeline/pipeline-core";

/**
 * Binding the AI Doom runner to its durable pilot, and refusing when it cannot.
 *
 * The pilot gate used to hang entirely off `PILOT_ID`: `currentPilot()` reads
 * that env var, and with it unset returned null, which `runPipeline` read as
 * "not a pilot run" and proceeded as ordinary production. So a PREPARED pilot
 * — a row whose whole purpose is to say "this channel is under a bounded,
 * private, capped regime" — protected nothing. Clearing PIPELINE_MODE with
 * PILOT_ID unset would have produced an uncapped run that uploaded with a
 * publishAt and generated a Short, because `uploadPolicyFor(null, slot)`
 * returns the ordinary-production policy.
 *
 * The absence of configuration is now treated as ambiguity rather than as
 * permission: if the database says a pilot governs this channel, the runner
 * refuses to act until the environment names it.
 *
 * AI Doom only. Wet Circuit binds its canary through its own tracked
 * authorisation manifest and is untouched by this module.
 */

const CHANNEL = "ai-doom-scroll" as const;

/** Statuses that mean "a pilot governs this channel right now". */
const GOVERNING = ["PREPARED", "ACTIVE"] as const;

type PilotRow = PilotConfig & { channel: string };

async function governingPilots(): Promise<PilotRow[]> {
  const rows = await (prisma as never as {
    productionPilot: { findMany(a: unknown): Promise<PilotRow[]> };
  }).productionPilot.findMany({
    where: { channel: CHANNEL, status: { in: [...GOVERNING] } },
    orderBy: { pilotId: "asc" },
  });
  return rows;
}

/**
 * The pilot governing this run, or null for ordinary non-pilot production.
 *
 * Fails closed on every ambiguity rather than falling back to unrestricted
 * production. Returns null ONLY when the database agrees there is no pilot to
 * honour, which keeps ordinary production available once a pilot is COMPLETED.
 *
 * Must be called before resume, discovery, or any candidate mutation.
 */
export async function resolveAiDoomPilot(): Promise<PilotConfig | null> {
  const governing = await governingPilots();
  const named = activePilotId();

  if (governing.length === 0) {
    // No pilot governs the channel. A stale PILOT_ID must still not be
    // silently ignored — it means the operator believes a pilot is in force.
    if (named) {
      const row = await getPilot(named);
      throw new PilotBlockedError(
        "PILOT_BINDING_STALE",
        `PILOT_ID=${named} is set but no PREPARED/ACTIVE pilot governs ${CHANNEL}` +
        `${row ? ` (that pilot is ${row.status})` : " (no such pilot)"} — refusing to run`,
      );
    }
    return null; // Ordinary production, by agreement of DB and environment.
  }

  if (governing.length > 1) {
    throw new PilotBlockedError(
      "PILOT_BINDING_AMBIGUOUS",
      `${governing.length} PREPARED/ACTIVE pilots govern ${CHANNEL} ` +
      `(${governing.map((p) => p.pilotId).join(", ")}) — refusing to choose one`,
    );
  }

  const governingPilot = governing[0]!;

  if (!named) {
    throw new PilotBlockedError(
      "PILOT_BINDING_REQUIRED",
      `pilot ${governingPilot.pilotId} (${governingPilot.status}) governs ${CHANNEL} ` +
      `but PILOT_ID is not set — refusing to run as ordinary production`,
    );
  }

  if (named !== governingPilot.pilotId) {
    throw new PilotBlockedError(
      "PILOT_BINDING_MISMATCH",
      `PILOT_ID=${named} does not match the pilot governing ${CHANNEL} ` +
      `(${governingPilot.pilotId}) — refusing to run`,
    );
  }

  // Resolved by id as well, so a row that changed channel between the two
  // reads cannot slip through.
  const bound = await getPilot(named);
  if (!bound) {
    throw new PilotBlockedError("PILOT_BINDING_MISSING",
      `PILOT_ID=${named} does not resolve to a pilot row`);
  }
  if (bound.channel !== CHANNEL) {
    throw new PilotBlockedError(
      "PILOT_BINDING_WRONG_CHANNEL",
      `pilot ${bound.pilotId} is for ${bound.channel}, not ${CHANNEL} — refusing to run it here`,
    );
  }
  return bound;
}

export interface WindowDecision {
  allowed: boolean;
  nowLocal: string;
  reason: string;
}

/**
 * Pure evaluation, so every boundary is testable without a database.
 *
 * `supervision` defaults to UNATTENDED — the branch that still enforces the
 * clock. A caller that forgets to declare itself supervised therefore gets the
 * window, never a waiver. See lib/supervision.ts for why permission is stated
 * rather than inferred from an omission.
 */
export function evaluateAiDoomPilotWindow(
  now: Date,
  pilot: PilotConfig,
  supervision: PilotSupervision = UNATTENDED,
): WindowDecision {
  const nowLocalAlways = formatZoned(now, pilot.timezone);

  // A human is running a control command with an acknowledgement flag right
  // now. The bound on this attempt is that authorization, the single-slot cap
  // and the relock — not the hour of the day.
  if (!windowApplies(supervision)) {
    return {
      allowed: true,
      nowLocal: nowLocalAlways,
      reason: "manually supervised pilot — the time-of-day window does not apply",
    };
  }

  const spec = {
    days: pilot.windowDays,
    startHour: pilot.windowStartHour,
    endHour: pilot.windowEndHour,
    timeZone: pilot.timezone,
  };
  const allowed = isInWindow(now, spec);
  const nowLocal = nowLocalAlways;
  return {
    allowed,
    nowLocal,
    reason: allowed
      ? `inside the authorised window (${spec.startHour}:00-${spec.endHour}:00 ${spec.timeZone})`
      : `outside the authorised window (days ${JSON.stringify(spec.days)} ` +
        `${spec.startHour}:00-${spec.endHour}:00 ${spec.timeZone}, end exclusive)`,
  };
}

/**
 * Refuse to run a bound pilot outside its execution window.
 *
 * This used to log and continue, which made the window a comment rather than a
 * control: a pilot that may run at any hour on any day is not bounded. The
 * refusal happens before resume, before discovery, and before any candidate row
 * is created, so it precedes budget reservation, narration, media acquisition,
 * rendering and upload.
 *
 * Applies to PILOT execution only. Ordinary non-pilot production never reaches
 * here, because the caller only invokes it for a resolved pilot — so completing
 * or removing the pilot restores unrestricted scheduling rather than silently
 * inheriting the pilot's window.
 *
 * Under MANUAL_SUPERVISED the window is not applied at all: a person invoked
 * this run deliberately, and the bound on it is the single-slot cap plus the
 * relock. The refusal below remains exactly as it was for UNATTENDED, which is
 * also the default when the caller says nothing.
 */
export function assertAiDoomPilotWindow(
  now: Date,
  pilot: PilotConfig,
  supervision: PilotSupervision = UNATTENDED,
): WindowDecision {
  const decision = evaluateAiDoomPilotWindow(now, pilot, supervision);
  if (!decision.allowed) {
    throw new PilotBlockedError(
      "PILOT_OUTSIDE_WINDOW",
      `pilot ${pilot.pilotId}: ${decision.reason}; now is ${decision.nowLocal}`,
    );
  }
  return decision;
}
