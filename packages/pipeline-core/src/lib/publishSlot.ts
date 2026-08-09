import { EASTERN, zonedParts, zonedTimeToUtc } from "./easternWindow";

/**
 * Ordinary-production publication slots, in the channel's timezone.
 *
 * The previous implementation picked `PUBLISH_HOUR_UTC = 19` and tested the
 * weekday with `getUTCDay()`. Both are wrong for a policy expressed as
 * "Monday/Wednesday/Friday at 3 PM Eastern":
 *
 *   - A fixed UTC hour is a moving local hour. 19:00Z is 15:00 EDT in summer
 *     but 14:00 EST in winter, so the published time silently shifted by an
 *     hour twice a year.
 *   - A UTC weekday is not an Eastern weekday. Late-evening Eastern times fall
 *     on the next UTC day, so a Sunday 20:00 ET instant reads as Monday in UTC
 *     and would have been treated as a publication day.
 *
 * The slot is now defined the way the policy is stated — local wall clock, local
 * weekday — and converted to UTC at the end, which is DST-safe by construction
 * and independent of the host's own timezone.
 *
 * THREE DIFFERENT CONCEPTS share the Mon/Wed/Fri shape and must not be
 * conflated:
 *
 *   1. This: when ordinary unattended production PUBLISHES (15:00 ET).
 *   2. The pilot EXECUTION window (17:00-20:00 ET) — when a private pilot may
 *      RUN. It never becomes a publish time.
 *   3. The manual post-review scheduling tool, where the operator names an
 *      explicit time and this default does not apply.
 */

/** Publication weekdays, 1 = Monday. */
export const PUBLISH_DAYS = [1, 3, 5];

/**
 * Publication wall clock, in `PUBLISH_TIMEZONE`.
 *
 * Grounded in durable history rather than chosen: every scheduled Wet Circuit
 * row (9/9) landed at 15:00 ET, as did 19 of 23 AI Doom rows and all five of
 * the most recent. The four older 10:00 ET rows predate that convergence.
 */
export const PUBLISH_HOUR_LOCAL = 15;
export const PUBLISH_MINUTE_LOCAL = 0;
export const PUBLISH_TIMEZONE = EASTERN;

/** A channel's ordinary publication policy. */
export interface PublicationPolicy {
  channel: string;
  /** Publication weekdays, 1 = Monday. */
  days: number[];
  hour: number;
  minute: number;
  timeZone: string;
}

/**
 * The publication policy for a channel.
 *
 * Both channels share Mon/Wed/Fri 15:00 America/New_York, and that is a finding
 * rather than an assumption. Audited against durable production history on
 * 2026-08-09, reading the stored instants as UTC and converting to Eastern:
 *
 *   ai-doom-scroll : Mon 9, Wed 5, Fri 5 at 15:00 ET (19 rows), plus 4 older
 *                    Wed 10:00 ET rows that predate the convergence.
 *   wet-circuit    : Mon 4, Wed 2, Fri 3 at 15:00 ET (9 rows, 9/9).
 *
 * No row on either channel has ever been scheduled on a Tue/Thu. The one file
 * that still said Tue/Thu — scripts/prepare-wc-canary.ts — was describing the
 * pilot EXECUTION window, not publication, and was itself stale against both
 * canary/authorization.ts and the durable pilot row; it was corrected in the
 * same pass that added this function.
 *
 * The lookup is per-channel even though the answer is currently identical for
 * both, so a future divergence is a table entry rather than a refactor of every
 * call site, and so "these are the same on purpose" is something a test can
 * assert rather than something implied by a channel-blind constant.
 */
export function publicationPolicyFor(channel: string): PublicationPolicy {
  return {
    channel,
    days: PUBLISH_DAYS,
    hour: PUBLISH_HOUR_LOCAL,
    minute: PUBLISH_MINUTE_LOCAL,
    timeZone: PUBLISH_TIMEZONE,
  };
}

export interface SlotOptions {
  /** Slots already taken by other future videos on the same channel. */
  occupied?: Date[];
  days?: number[];
  hour?: number;
  minute?: number;
  timeZone?: string;
  /** How far ahead to search before giving up. */
  horizonDays?: number;
}

/**
 * The next unoccupied publication slot strictly after `from`.
 *
 * Same-day is allowed when the slot has not yet passed, which preserves the
 * previous behaviour for a run that finishes before the publication hour.
 * Occupied slots are skipped by exact instant, so two videos never land on the
 * same timestamp — the old implementation had no collision handling at all and
 * would hand the same slot to every video produced on a given day.
 */
export function nextPublishSlot(from: Date = new Date(), opts: SlotOptions = {}): Date {
  const days = opts.days ?? PUBLISH_DAYS;
  const hour = opts.hour ?? PUBLISH_HOUR_LOCAL;
  const minute = opts.minute ?? PUBLISH_MINUTE_LOCAL;
  const tz = opts.timeZone ?? PUBLISH_TIMEZONE;
  const horizon = opts.horizonDays ?? 60;
  const taken = new Set((opts.occupied ?? []).map((d) => d.getTime()));

  // Walk local calendar days, not UTC days: the weekday that matters is the one
  // a viewer in `tz` sees.
  const startParts = zonedParts(from, tz);
  for (let i = 0; i <= horizon; i++) {
    // Advance by whole days from the local date, re-deriving local parts each
    // step so a DST transition cannot drift the calendar.
    const probe = new Date(
      zonedTimeToUtc(startParts.year, startParts.month, startParts.day, 12, 0, tz).getTime()
      + i * 86_400_000,
    );
    const p = zonedParts(probe, tz);
    if (!days.includes(p.weekday)) continue;

    const slot = zonedTimeToUtc(p.year, p.month, p.day, hour, minute, tz);
    if (slot.getTime() <= from.getTime()) continue; // strictly future
    if (taken.has(slot.getTime())) continue;
    return slot;
  }
  throw new Error(
    `no unoccupied publication slot within ${horizon} days of ${from.toISOString()}`,
  );
}

/** Human-readable description, for logs and dry-run output. */
export function describeSlot(slot: Date, timeZone = PUBLISH_TIMEZONE): string {
  const p = zonedParts(slot, timeZone);
  return `${slot.toISOString()} (${String(p.hour).padStart(2, "0")}:` +
    `${String(p.minute).padStart(2, "0")} local, weekday ${p.weekday}, ${timeZone})`;
}
