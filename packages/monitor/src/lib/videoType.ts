/**
 * Short vs long-form classification helpers.
 *
 * The YouTube Data API does NOT expose a direct "is this a Short?" flag.
 * The de facto signal is duration: a Short is a vertical video ≤ 60s.
 * We fetch `contentDetails.duration` (ISO 8601, e.g. "PT45S", "PT1M30S")
 * from videos.list and parse it here.
 *
 * Threshold deliberately set to 60s inclusive — matches YouTube's own
 * Shorts cutoff. Videos at exactly 60.000s count as Shorts.
 */

const SHORT_DURATION_SECONDS = 60;

/**
 * Parse an ISO 8601 duration like "PT1H2M3S" / "PT45S" / "PT1M30S" to
 * total seconds. Returns 0 on malformed input. Sufficient for YouTube
 * video durations (no day/week/month components in practice).
 */
export function parseIsoDurationSeconds(iso: string | null | undefined): number {
  if (!iso) return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return 0;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Classify a video as Short or long-form by duration.
 * Accepts either a raw seconds count or a `{ durationSeconds }` shape so
 * callers can pass parsed VideoMetrics directly.
 */
export function isShortVideo(
  input: number | { durationSeconds?: number | null },
): boolean {
  const seconds =
    typeof input === "number"
      ? input
      : (input.durationSeconds ?? 0);
  return seconds > 0 && seconds <= SHORT_DURATION_SECONDS;
}

export type VideoTypeLabel = "SHORT" | "LONG";

/**
 * Return a stable string label for in-memory routing/log output.
 * Returns "LONG" by default when duration is missing/zero — guards against
 * misclassifying long-forms with absent metadata as Shorts.
 */
export function videoTypeLabel(
  input: number | { durationSeconds?: number | null },
): VideoTypeLabel {
  return isShortVideo(input) ? "SHORT" : "LONG";
}
