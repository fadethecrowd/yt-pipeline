/**
 * Execution windows in America/New_York, daylight-saving aware.
 *
 * The old slot calculator hardcoded 19:00 UTC and commented it "2 PM EST".
 * Both halves were wrong for the intended window: 19:00 UTC is 3 PM in EDT
 * and 2 PM in EST, so the actual local time silently moved by an hour twice a
 * year and never fell inside the 5–8 PM window anyone wanted. A fixed offset
 * cannot express a rule stated in local time.
 *
 * Offsets are read from the IANA database through Intl rather than assumed, so
 * a DST rule change is picked up without editing anything here.
 *
 * An EXECUTION time is when the pipeline runs. It is deliberately a separate
 * concept from a YouTube publishAt: a private pilot runs inside this window
 * and publishes nothing.
 */

/** Monday, Wednesday, Friday. */
export const DEFAULT_WINDOW_DAYS = [1, 3, 5];
export const DEFAULT_WINDOW_START_HOUR = 17; // 5 PM
export const DEFAULT_WINDOW_END_HOUR = 20;   // 8 PM
export const EASTERN = "America/New_York";

export interface WindowSpec {
  days?: number[];
  startHour?: number;
  endHour?: number;
  timeZone?: string;
}

interface Parts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number; weekday: number;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock fields of `date` as observed in `timeZone`. */
export function zonedParts(date: Date, timeZone = EASTERN): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") got[p.type] = p.value;
  // Intl renders midnight as hour 24 under hour12:false in some engines.
  const hour = Number(got.hour) % 24;
  return {
    year: Number(got.year), month: Number(got.month), day: Number(got.day),
    hour, minute: Number(got.minute), second: Number(got.second),
    weekday: WEEKDAY.indexOf(got.weekday!),
  };
}

/** The zone's UTC offset in minutes at `date` (negative west of Greenwich). */
export function offsetMinutes(date: Date, timeZone = EASTERN): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** True while the zone is on daylight time. */
export function isDst(date: Date, timeZone = EASTERN): boolean {
  const jan = offsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12)), timeZone);
  const jul = offsetMinutes(new Date(Date.UTC(date.getUTCFullYear(), 6, 1, 12)), timeZone);
  return offsetMinutes(date, timeZone) === Math.max(jan, jul) && jan !== jul;
}

/**
 * The instant at which `timeZone` reads the given wall-clock time.
 *
 * Solved rather than computed from a stored offset: the offset that applies
 * depends on the instant, and the instant is what is being solved for. Two
 * passes settle it, including across a DST boundary.
 */
export function zonedTimeToUtc(
  y: number, m: number, d: number, hour: number, minute = 0, timeZone = EASTERN,
): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes(guess, timeZone);
    const next = new Date(Date.UTC(y, m - 1, d, hour, minute) - off * 60000);
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

export function isWindowDay(date: Date, spec: WindowSpec = {}): boolean {
  const days = spec.days ?? DEFAULT_WINDOW_DAYS;
  return days.includes(zonedParts(date, spec.timeZone ?? EASTERN).weekday);
}

/** Whether `date` falls on a window day, inside [startHour, endHour). */
export function isInWindow(date: Date, spec: WindowSpec = {}): boolean {
  const tz = spec.timeZone ?? EASTERN;
  const p = zonedParts(date, tz);
  const days = spec.days ?? DEFAULT_WINDOW_DAYS;
  const start = spec.startHour ?? DEFAULT_WINDOW_START_HOUR;
  const end = spec.endHour ?? DEFAULT_WINDOW_END_HOUR;
  return days.includes(p.weekday) && p.hour >= start && p.hour < end;
}

/**
 * Start of the next execution window strictly after `from`.
 *
 * Returns the window's opening instant, so a caller may run any time between
 * it and the closing hour.
 */
export function nextWindowStart(from: Date = new Date(), spec: WindowSpec = {}): Date {
  const tz = spec.timeZone ?? EASTERN;
  const days = spec.days ?? DEFAULT_WINDOW_DAYS;
  const start = spec.startHour ?? DEFAULT_WINDOW_START_HOUR;

  for (let i = 0; i <= 14; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const p = zonedParts(probe, tz);
    if (!days.includes(p.weekday)) continue;
    const candidate = zonedTimeToUtc(p.year, p.month, p.day, start, 0, tz);
    if (candidate > from) return candidate;
  }
  throw new Error("no execution window found within 14 days");
}

/** Human-readable local rendering, for logs and reports. */
export function formatZoned(date: Date, timeZone = EASTERN): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(date);
}
