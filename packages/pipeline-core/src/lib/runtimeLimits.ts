/**
 * Runtime time limits, in one place because two different files depend on the
 * same number meaning the same thing.
 *
 * The hard timeout is the ceiling on how long a pipeline process may live: both
 * entrypoints arm a timer for it and force-exit when it fires. That makes it
 * the only defensible basis for deciding a claim is abandoned — a claim younger
 * than the ceiling may still belong to a running process, and a claim older
 * than it cannot, because such a process would have killed itself.
 *
 * Previously each entrypoint declared `30 * 60 * 1000` locally and the stale
 * threshold was an unrelated literal. Raising one without the other would have
 * either made recovery reap live runs or left abandoned claims undetected, and
 * nothing in the code connected the two.
 */

/**
 * How long a pipeline process may run before it force-exits.
 *
 * Grounded against durable history (audited 2026-08-09, `pipeline_run`):
 * the longest successful LIVE run on either channel is 13.3 min (wet-circuit,
 * n=6, avg 9.5), and AI Doom's longest is 9.2 min (n=5, avg 7.0). The ceiling
 * therefore sits at ~2.3x the worst observed success.
 */
export const PIPELINE_HARD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a CLAIMED cycle may sit untouched before it is considered abandoned.
 *
 * 1.5x the hard timeout. The reasoning is a chain of upper bounds, not a
 * preference: a healthy run finishes in ≤13.3 min observed; any run at all is
 * dead by 30 min because the process kills itself; so at 45 min the owning
 * process is gone with 15 minutes of slack for a slow shutdown, a delayed
 * timer, or clock skew between the container and the database.
 *
 * This is the threshold for REPORTING a claim as stale, and the precondition —
 * never the sole justification — for terminalising one. Age alone never
 * releases a claim; see `failAbandonedCycle`, which additionally requires the
 * channel advisory lock to prove no live session holds it.
 */
export const CLAIM_STALE_AFTER_MS = PIPELINE_HARD_TIMEOUT_MS * 1.5;
