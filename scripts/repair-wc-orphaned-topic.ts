/**
 * One-time repair for the library-accounting leak observed 2026-09-11.
 *
 * An OOM kill during a production batch left wc_video cmtxfozd80002mbkibgztqta7
 * stranded at SCRIPT_PENDING. That status was not in RESUME_FROM, so nothing
 * would ever pick the row up — while the topic_library row it had consumed
 * ("VHF Radio Basics: DSC, MMSI, and Channel 16") stayed marked USED. One
 * curated topic burned, no video produced.
 *
 * The code fix (SCRIPT_PENDING added to RESUME_FROM) stops FUTURE crashes from
 * orphaning a topic. This script repairs the one row that already leaked.
 *
 * Why it also quarantines the stranded video, which is not obvious:
 *   Returning the library row to PENDING and leaving the video resumable would
 *   consume the topic TWICE. topicDiscovery upserts wc_topic BY URL, so a
 *   re-picked library row reuses the very same wc_topic the stranded video is
 *   bound to, and a second wc_video is created against it. With SCRIPT_PENDING
 *   now resumable, the stranded row would ALSO run. Two videos, one topic,
 *   ~4,500 wasted ElevenLabs credits.
 *
 *   The stranded row holds zero work — SCRIPT_PENDING means no script, no
 *   render, no spend — so discarding it costs nothing. Quarantine is used
 *   rather than a raw status write because it records originalStatus in
 *   job_quarantine and is reversible via releaseQuarantine(), and because its
 *   "[ack][quarantined]" reason prefix already satisfies the wc-pipeline halt
 *   guard, so it cannot wedge the next run.
 *
 * Read-only by default. Pass --apply to write.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { quarantineJob } from "../packages/pipeline-core/src/lib/quarantine";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const VIDEO_ID = "cmtxfozd80002mbkibgztqta7";
const LIBRARY_ID = "cmtxbcqoi0009mba8fh48gwk3";

async function main() {
  const video = await prisma.wcVideo.findUnique({
    where: { id: VIDEO_ID },
    include: { topic: true },
  });
  const lib = await prisma.topicLibrary.findUnique({ where: { id: LIBRARY_ID } });

  if (!video) throw new Error(`wc_video ${VIDEO_ID} not found`);
  if (!lib) throw new Error(`topic_library ${LIBRARY_ID} not found`);

  console.log("Before:");
  console.log(`  video   ${video.id}  status=${video.status}  youtubeId=${video.youtubeId ?? "-"}`);
  console.log(`  topic   ${video.topic?.id}  url=${video.topic?.url}`);
  console.log(`  library ${lib.id}  status=${lib.status}  priority=${lib.priority}  "${lib.title}"`);

  // Refuse on anything but the exact state this repair was written for.
  if (video.status !== "SCRIPT_PENDING") {
    console.log(`\nRefusing: video status is ${video.status}, expected SCRIPT_PENDING.`);
    console.log("The row has moved on — re-diagnose rather than forcing this repair.");
    return;
  }
  if (video.youtubeId) {
    console.log(`\nRefusing: video already has youtubeId ${video.youtubeId}.`);
    return;
  }
  if (lib.status !== "USED") {
    console.log(`\nRefusing: library status is ${lib.status}, expected USED. Already repaired?`);
    return;
  }
  if (video.topic?.url !== `library://${LIBRARY_ID}`) {
    console.log(`\nRefusing: video's topic url ${video.topic?.url} does not name library row ${LIBRARY_ID}.`);
    return;
  }

  console.log("\nPlanned:");
  console.log(`  quarantine wc_video ${VIDEO_ID}  (SCRIPT_PENDING -> terminal, reversible)`);
  console.log(`  topic_library ${LIBRARY_ID}      USED -> PENDING`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  const q = await quarantineJob({
    channel: "wet-circuit",
    videoId: VIDEO_ID,
    table: "wc_video",
    reason: "stranded at SCRIPT_PENDING by an OOM kill; topic returned to the library instead",
    operator: "repair-wc-orphaned-topic",
    actionSource: "scripts/repair-wc-orphaned-topic.ts",
  });
  console.log(`\nQuarantined: ${q.originalStatus} -> ${q.newStatus} (quarantine ${q.quarantineId})`);

  const after = await prisma.topicLibrary.update({
    where: { id: LIBRARY_ID },
    data: { status: "PENDING" },
    select: { id: true, status: true, priority: true, title: true },
  });
  console.log(`Library row restored: ${JSON.stringify(after)}`);
  console.log("\nThe topic is back in the queue and the stranded row cannot resume into a duplicate.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
