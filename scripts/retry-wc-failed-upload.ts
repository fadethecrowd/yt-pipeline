/**
 * Find the most recent WC video that failed upload with "invalid video
 * keywords" and flip it back into the resume queue at ASSEMBLY_DONE so
 * the next wc-pipeline run picks it up at youtubeUpload.
 *
 * Read-only by default. Pass --apply to actually update the row.
 *   npx tsx scripts/retry-wc-failed-upload.ts          # dry-run
 *   npx tsx scripts/retry-wc-failed-upload.ts --apply  # write
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const candidate = await prisma.wcVideo.findFirst({
    where: {
      status: "FAILED",
      failReason: { contains: "invalid video keywords" },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      failReason: true,
      videoPath: true,
      voiceoverUrls: true,
      voiceoverPath: true,
      seoTitle: true,
      seoTags: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!candidate) {
    console.log("No FAILED wc_video matching '%invalid video keywords%' found.");
    return;
  }

  console.log("=== Candidate ===");
  console.log({
    id: candidate.id,
    status: candidate.status,
    updatedAt: candidate.updatedAt.toISOString(),
    seoTitle: candidate.seoTitle,
    seoTagsCount: candidate.seoTags?.length ?? 0,
    videoPath: candidate.videoPath,
    voiceoverPath: candidate.voiceoverPath,
    voiceoverUrlsCount: candidate.voiceoverUrls?.length ?? 0,
    failReason: candidate.failReason,
  });

  // We can only check filesystem locally (the file lives on the Railway
  // wc-pipeline container, not here). Surface this so the user knows.
  console.log("\n=== Local filesystem checks (NOT authoritative for Railway) ===");
  console.log(
    `  videoPath exists locally:    ${candidate.videoPath ? existsSync(candidate.videoPath) : "n/a"}`,
  );
  console.log(
    `  voiceoverPath exists locally: ${candidate.voiceoverPath ? existsSync(candidate.voiceoverPath) : "n/a"}`,
  );

  console.log("\n=== Plan ===");
  console.log("  Set status='ASSEMBLY_DONE', failReason=NULL, updatedAt=NOW()");
  console.log("  → next wc-pipeline run will resume at youtubeUpload");
  console.log(
    "  Fallback if videoPath missing on Railway: set status='VOICEOVER_DONE'",
  );
  console.log("  Fallback if voiceover missing too: set status='SEO_DONE'");

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  const updated = await prisma.wcVideo.update({
    where: { id: candidate.id },
    data: {
      status: "ASSEMBLY_DONE",
      failReason: null,
    },
    select: { id: true, status: true, failReason: true, updatedAt: true },
  });

  console.log("\n=== Applied ===");
  console.log(updated);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
