import { prisma } from "./prisma";

/**
 * Shared Prisma where-clause fragments for monitor queries.
 *
 * liveVideoWhere matches real (non-dry-run) videos that have a
 * YouTube ID. The pipeline's DRY_RUN path (DISABLE_ELEVEN=true) writes
 * a placeholder `dryrun-<cuid>` into Video.youtubeId so resume logic
 * skips the upload stage — the monitor has no business acting on those
 * rows. Exclude them explicitly here rather than relying on the
 * accidental filters (no snapshots exist, scheduledAt is null) that
 * have kept them out of decision paths so far.
 *
 * Spread into Prisma where-clauses alongside any additional conditions:
 *
 *   where: { ...liveVideoWhere, scheduledAt: { lte: new Date() } }
 */
export const liveVideoWhere = {
  youtubeId: { not: null },
  NOT: { youtubeId: { startsWith: "dryrun-" as const } },
} as const;

/**
 * Videos the monitor must ignore entirely.
 *
 * Diagnostic and qualification renders are uploaded privately with a real
 * YouTube ID and no scheduledAt, which is exactly what `liveVideoWhere` plus
 * the poller's "published or unscheduled" clause selects — so without this the
 * monitor would snapshot private test assets, and could raise alerts or
 * retitle them as if they were live content.
 *
 * Quarantined videos are the durable marker for "not real content": every
 * diagnostic row is quarantined when it is created.
 */
export async function excludedVideoIds(): Promise<string[]> {
  const rows = await prisma.jobQuarantine.findMany({
    where: { releasedAt: null },
    select: { videoId: true },
  });
  return rows.map((r) => r.videoId);
}

/**
 * `liveVideoWhere` with quarantined rows removed. Async because the exclusion
 * set lives in the database; callers should build it once per tick.
 */
export async function liveVideoWhereExcludingQuarantined() {
  const excluded = await excludedVideoIds();
  return {
    ...liveVideoWhere,
    ...(excluded.length ? { id: { notIn: excluded } } : {}),
  };
}
