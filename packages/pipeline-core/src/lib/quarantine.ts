import { VideoStatus } from "@prisma/client";
import { prisma } from "./db";

/**
 * Explicit, reversible job quarantine.
 *
 * The pipelines resume work by selecting videos whose status is in RESUME_FROM,
 * so any stale row left in a resumable status is picked up on the next restart.
 * Quarantining records the original status in `job_quarantine` and moves the row
 * to a non-resumable status. Nothing is deleted and no artifact is touched, so
 * the change is reversible by writing `originalStatus` back.
 */

/** Statuses the pipelines will auto-resume from. Keep in sync with RESUME_FROM. */
export const RESUMABLE_STATUSES: VideoStatus[] = [
  VideoStatus.SEO_DONE,
  VideoStatus.VOICEOVER_DONE,
  VideoStatus.ASSEMBLY_DONE,
  VideoStatus.ASSEMBLY_PENDING,
  VideoStatus.UPLOAD_PENDING,
];

/** Terminal status used for quarantine. Deliberately not in RESUMABLE_STATUSES. */
export const QUARANTINE_STATUS = VideoStatus.FAILED;

/** Prefix that also satisfies the wc-pipeline halt guard's acknowledgement check. */
export const QUARANTINE_PREFIX = "[ack][quarantined]";

export interface QuarantineInput {
  channel: string;
  videoId: string;
  table: "Video" | "wc_video";
  reason: string;
  operator: string;
  actionSource: string;
}

export interface QuarantineResult {
  videoId: string;
  originalStatus: string;
  newStatus: string;
  quarantineId: string;
  createdAt: Date;
}

export async function quarantineJob(
  input: QuarantineInput,
): Promise<QuarantineResult> {
  const isWc = input.table === "wc_video";

  const row = isWc
    ? await prisma.wcVideo.findUnique({ where: { id: input.videoId } })
    : await prisma.video.findUnique({ where: { id: input.videoId } });
  if (!row) throw new Error(`No ${input.table} row with id ${input.videoId}`);

  const existing = await prisma.jobQuarantine.findFirst({
    where: { videoId: input.videoId, releasedAt: null },
  });
  if (existing) {
    return {
      videoId: input.videoId,
      originalStatus: existing.originalStatus,
      newStatus: existing.newStatus,
      quarantineId: existing.id,
      createdAt: existing.createdAt,
    };
  }

  const originalStatus = row.status;
  const failReason = `${QUARANTINE_PREFIX} ${input.reason} (was ${originalStatus}; by ${input.operator} via ${input.actionSource})`;

  // Record first, then move the row: if the status update fails, the audit row
  // is harmless; if the record failed, we would have moved a row with no way
  // back to its original status.
  const record = await prisma.jobQuarantine.create({
    data: {
      channel: input.channel,
      videoId: input.videoId,
      table: input.table,
      originalStatus,
      newStatus: QUARANTINE_STATUS,
      reason: input.reason,
      operator: input.operator,
      actionSource: input.actionSource,
    },
  });

  const data = { status: QUARANTINE_STATUS, failReason };
  if (isWc) {
    await prisma.wcVideo.update({ where: { id: input.videoId }, data });
  } else {
    await prisma.video.update({ where: { id: input.videoId }, data });
  }

  return {
    videoId: input.videoId,
    originalStatus,
    newStatus: QUARANTINE_STATUS,
    quarantineId: record.id,
    createdAt: record.createdAt,
  };
}

/** Restore a quarantined job to the status it held before quarantine. */
export async function releaseQuarantine(
  videoId: string,
  releasedBy: string,
): Promise<QuarantineResult> {
  const record = await prisma.jobQuarantine.findFirst({
    where: { videoId, releasedAt: null },
  });
  if (!record) throw new Error(`No active quarantine for ${videoId}`);

  const data = {
    status: record.originalStatus as VideoStatus,
    failReason: null,
  };
  if (record.table === "wc_video") {
    await prisma.wcVideo.update({ where: { id: videoId }, data });
  } else {
    await prisma.video.update({ where: { id: videoId }, data });
  }

  await prisma.jobQuarantine.update({
    where: { id: record.id },
    data: { releasedAt: new Date(), releasedBy },
  });

  return {
    videoId,
    originalStatus: record.originalStatus,
    newStatus: record.originalStatus,
    quarantineId: record.id,
    createdAt: record.createdAt,
  };
}

/** Video ids currently quarantined — excluded from any resume selection. */
export async function quarantinedVideoIds(): Promise<string[]> {
  const rows = await prisma.jobQuarantine.findMany({
    where: { releasedAt: null },
    select: { videoId: true },
  });
  return rows.map((r) => r.videoId);
}

/**
 * Rows a pipeline restart would auto-resume, excluding anything quarantined.
 * Used by the pre-deployment check and by the pipelines themselves.
 */
export async function resumableJobs(channel: "ai-doom-scroll" | "wet-circuit") {
  const excluded = await quarantinedVideoIds();
  const where = {
    status: { in: RESUMABLE_STATUSES },
    id: { notIn: excluded.length ? excluded : ["__none__"] },
  };
  return channel === "wet-circuit"
    ? prisma.wcVideo.findMany({ where, select: { id: true, status: true, createdAt: true } })
    : prisma.video.findMany({ where, select: { id: true, status: true, createdAt: true } });
}
