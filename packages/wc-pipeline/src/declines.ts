/**
 * The difference between a pipeline that refused and a pipeline that broke.
 *
 * `failVideo` sets status FAILED with runMode LIVE, which is exactly the
 * halt-guard condition: the next run finds an unacknowledged LIVE failure
 * within 24h and refuses to start until a human prefixes failReason with
 * "[ack]". That is the right response to ffmpeg dying, an upload failing, or a
 * budget being exceeded — something is wrong and more runs will make it worse.
 *
 * It is the wrong response to the model declining to write from a 400-character
 * RSS teaser. That decline is the pipeline working: it refused to fabricate
 * specs, before a character was bought. 26 of 56 approved topics decline that
 * way, so treating each one as a fault turns bulk production into a treadmill
 * of hand-editing failReason between runs.
 *
 * Two stages already encoded this distinction and lost it. `qualityGate` and
 * `visualFeasibilityGate` both deliberately set QUALITY_FAILED — a status the
 * halt guard does not match — and `failVideo` then overwrote it with FAILED.
 * The intent existed; only the plumbing was missing.
 *
 * So a stage that refuses on the INPUT marks its result, and `runStages`
 * settles it as QUALITY_FAILED instead of FAILED. Nothing is suppressed: the
 * row is still terminal, still carries its reason, and still ends the run. It
 * simply does not claim that the machine is broken when it is not.
 */

/** Marker attached to `StageResult.data` by a stage that refused pre-spend. */
export interface PreSpendDecline {
  declined: true;
  /** Why, in the refusing stage's own vocabulary — e.g. "THIN_SOURCE". */
  kind: string;
}

export function preSpendDecline(kind: string): PreSpendDecline {
  return { declined: true, kind };
}

/**
 * Did this stage refuse the input, rather than fail at its job?
 *
 * Deliberately structural rather than a string match on the error: a decline
 * is something a stage asserts about its own outcome, not something the
 * orchestrator infers from a message it does not own.
 */
export function isPreSpendDecline(result: { data?: unknown }): boolean {
  const d = result.data as Partial<PreSpendDecline> | undefined;
  return !!d && d.declined === true;
}

/**
 * Model-response classifications that are declines rather than faults.
 *
 * Everything here is the model or its output being unusable for THIS input,
 * which a different topic fixes. `API_ERROR` is deliberately absent: a failed
 * Anthropic call says something about the environment, not the topic, and
 * repeated ones are exactly what an operator should be stopped for.
 */
export const DECLINE_FAILURE_TYPES: ReadonlySet<string> = new Set([
  "MODEL_REFUSAL",
  "OFF_TOPIC",
  "THIN_SOURCE",
  "TRUNCATED_JSON",
  "MALFORMED_JSON",
  "EMPTY_RESPONSE",
  "SCHEMA_INVALID",
]);

export function isDeclineFailureType(t: string | undefined): boolean {
  return !!t && DECLINE_FAILURE_TYPES.has(t);
}
