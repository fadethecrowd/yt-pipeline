/**
 * Reconcile a video that exists on YouTube but must never publish.
 *
 *   npx tsx scripts/reconcile-abandoned-upload.ts --video <id> --reason "..." \
 *     --i-understand-this-abandons-the-video
 *
 * The pipeline uploads private with a future publishAt. When a human reviews
 * the result and sets it private-with-no-schedule on YouTube, the durable row
 * still carries `scheduledAt` and the monitor correctly reports
 * PUBLISH_AT_MISSING: our records and the channel disagree.
 *
 * Reconciling means saying so durably. `quarantineJob` is the repo's existing
 * representation of an abandoned job — it writes an audit row recording the
 * original status and moves the row to FAILED — and clearing `scheduledAt`
 * makes the database agree with YouTube.
 *
 * That combination cannot resurrect the candidate. FAILED is absent from
 * RESUME_FROM, and a quarantined id is excluded from the resume query outright,
 * so it can be neither resumed, re-rendered, re-uploaded nor re-scheduled. The
 * slot it was holding becomes free again, which is correct: the video is not
 * going to publish into it.
 *
 * The uploaded video itself is untouched — this changes our records, not the
 * channel. LOCAL ONLY.
 */
import { prisma, disconnect, quarantineJob } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CONFIRM = "--i-understand-this-abandons-the-video";
const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
};

async function main(): Promise<void> {
  const videoId = arg("--video");
  const reason = arg("--reason");
  if (!videoId || !reason) {
    console.error("✗ --video and --reason are required");
    process.exitCode = 2; return;
  }
  if (!process.argv.includes(CONFIRM)) {
    console.error(`✗ ${CONFIRM} is required. Refusing.`);
    process.exitCode = 2; return;
  }

  const before = await prisma.video.findUnique({ where: { id: videoId } });
  if (!before) { console.error(`✗ no Video row ${videoId}`); process.exitCode = 1; return; }
  console.log(`   before: status=${before.status} youtubeId=${before.youtubeId} ` +
    `scheduledAt=${before.scheduledAt?.toISOString() ?? "null"}`);

  const q = await quarantineJob({
    channel: "ai-doom-scroll", videoId, table: "Video",
    reason, operator: "operator", actionSource: "reconcile-abandoned-upload",
  });
  console.log(`   quarantined: ${q.originalStatus} → ${q.newStatus} (audit ${q.quarantineId})`);

  // Make the schedule agree with YouTube. Conditional so a row that somehow
  // regained a schedule between the read and here is not silently overwritten.
  const cleared = await prisma.video.updateMany({
    where: { id: videoId, scheduledAt: before.scheduledAt },
    data: { scheduledAt: null },
  });
  console.log(`   scheduledAt cleared: ${cleared.count} row(s)`);

  const after = await prisma.video.findUnique({ where: { id: videoId } });
  console.log(`   after : status=${after?.status} youtubeId=${after?.youtubeId} ` +
    `scheduledAt=${after?.scheduledAt?.toISOString() ?? "null"}`);
  console.log(`   the uploaded video itself was NOT touched`);
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
