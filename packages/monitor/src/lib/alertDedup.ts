/**
 * Alert deduplication.
 *
 * `runHealthTick` sent the whole finding list to Telegram on EVERY tick that
 * produced any finding. One unresolved upload intent — a condition that by
 * design persists until a human acts — therefore produced an alert every poll
 * interval, indefinitely. That is not a cosmetic problem: an operator who
 * learns that the alert channel repeats itself stops reading it, and the one
 * genuinely new ALERT arrives into a stream nobody trusts. Deduplication is
 * what makes the alerting built for unattended production worth having.
 *
 * The rules are deliberately simple, because alerting logic that is itself hard
 * to reason about is its own hazard:
 *
 *   1. A finding is identified by (code, subject). Same problem, same identity,
 *      however the detail text is worded.
 *   2. A new identity notifies immediately.
 *   3. A repeat identity stays silent until the re-notify interval elapses, so
 *      an unresolved condition reminds you occasionally rather than constantly.
 *   4. An identity that disappears notifies ONCE as resolved, then is forgotten.
 *      A condition clearing is information — often the information that the
 *      thing you did worked.
 *
 * State is held by the caller, so this module is pure and the store can be
 * swapped without touching the rules. The monitor keeps it in memory: monitors
 * run continuously for days, so the storm is bounded to at most one alert per
 * condition per deploy, and that costs no migration before the pilots. A
 * durable store can be added later without changing anything here.
 */

export interface AlertIdentity {
  code: string;
  subject: string;
}

export interface AlertRecord {
  /** When this identity was last notified. */
  lastNotifiedAt: number;
  /**
   * The identity itself, carried rather than re-derived.
   *
   * Parsing it back out of the composite key would break the first time a
   * subject contained the separator — and subjects are free text from findings,
   * so that is a matter of time, not of chance.
   */
  identity: AlertIdentity;
}

export type AlertState = Map<string, AlertRecord>;

export function newAlertState(): AlertState {
  return new Map();
}

/**
 * Composite key for one alert identity.
 *
 * The separator is NUL because it cannot occur in a code or subject, so two
 * different identities can never collide into one key. Nothing ever parses the
 * key back apart — `AlertRecord` carries the identity — so this only has to be
 * unambiguous, not readable.
 */
export function alertKey(f: AlertIdentity): string {
  return `${f.code}\u0000${f.subject}`;
}

/**
 * How long an unchanged condition stays silent before reminding.
 *
 * Six hours: long enough that a condition awaiting a human does not nag, short
 * enough that something forgotten overnight resurfaces before the next
 * publication slot. Publication slots are 48 hours apart, so a condition can
 * never persist across a whole slot without at least one reminder.
 */
export const RENOTIFY_AFTER_MS = 6 * 60 * 60 * 1000;

export interface DedupInput<T extends AlertIdentity> {
  findings: T[];
  state: AlertState;
  now: Date;
  renotifyAfterMs?: number;
}

export interface DedupResult<T extends AlertIdentity> {
  /** Findings to actually send: new, or due a reminder. */
  notify: T[];
  /** Identities that were alerting and no longer are. */
  resolved: AlertIdentity[];
  /** Findings suppressed as unchanged repeats. */
  suppressed: T[];
  /** The state to carry into the next tick. */
  nextState: AlertState;
}

/**
 * Decide what to send. Pure — it returns the next state rather than mutating.
 */
export function dedupeAlerts<T extends AlertIdentity>(
  input: DedupInput<T>,
): DedupResult<T> {
  const renotify = input.renotifyAfterMs ?? RENOTIFY_AFTER_MS;
  const nowMs = input.now.getTime();
  const nextState: AlertState = new Map();
  const notify: T[] = [];
  const suppressed: T[] = [];

  const currentKeys = new Set<string>();
  for (const f of input.findings) {
    const key = alertKey(f);
    // A finding list can legitimately contain the same identity twice; the
    // second occurrence must not be treated as a repeat of the first.
    if (currentKeys.has(key)) { suppressed.push(f); continue; }
    currentKeys.add(key);

    const prior = input.state.get(key);
    const identity: AlertIdentity = { code: f.code, subject: f.subject };
    if (!prior) {
      notify.push(f);
      nextState.set(key, { lastNotifiedAt: nowMs, identity });
      continue;
    }
    if (nowMs - prior.lastNotifiedAt >= renotify) {
      notify.push(f);
      nextState.set(key, { lastNotifiedAt: nowMs, identity });
      continue;
    }
    suppressed.push(f);
    nextState.set(key, prior);
  }

  const resolved: AlertIdentity[] = [];
  for (const [key, record] of input.state) {
    if (currentKeys.has(key)) continue;
    resolved.push(record.identity);
    // Deliberately NOT carried into nextState: once resolution is announced the
    // identity is forgotten, so if it returns it notifies immediately again.
  }

  return { notify, resolved, suppressed, nextState };
}

/** Human-readable resolution notice. */
export function formatResolved(channel: string, resolved: AlertIdentity[]): string {
  const lines = resolved.map((r) => `• RESOLVED ${r.code} — ${r.subject}`);
  return `Monitor health (${channel}) — ${resolved.length} condition(s) cleared:\n` +
    lines.join("\n");
}
