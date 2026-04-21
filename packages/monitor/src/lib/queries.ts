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
