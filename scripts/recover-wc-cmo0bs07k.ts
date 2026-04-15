/**
 * Recover the inflatable-kayak transducer video from UPLOAD_PENDING
 * back to SEO_DONE so the next wc-pipeline run regenerates thumbnail +
 * voiceover + assembly + upload (the original final.mp4 and voiceover
 * files are gone from the ephemeral container).
 *
 * Also acknowledges the cascaded unwanted video cmo0cph2p... (status
 * ASSEMBLY_PENDING with voiceover already burned but files lost) by
 * marking it FAILED with [ack] prefix, so the new halt-on-failure guard
 * doesn't block recovery of the original.
 *
 * Read-only by default. Pass --apply to write.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const ORIGINAL = "cmo0bs07k0005qm01znnaftlc";
const CASCADED = "cmo0cph2p0005ms01pvpwht3k";

async function main() {
  const original = await prisma.wcVideo.findUnique({
    where: { id: ORIGINAL },
    select: { id: true, status: true, failReason: true, seoTitle: true },
  });
  const cascaded = await prisma.wcVideo.findUnique({
    where: { id: CASCADED },
    select: { id: true, status: true, failReason: true, seoTitle: true },
  });

  console.log("=== Before ===");
  console.log("original:", original);
  console.log("cascaded:", cascaded);

  console.log("\n=== Plan ===");
  console.log(
    `  ${ORIGINAL}: -> SEO_DONE (recover; will re-burn ElevenLabs)`,
  );
  console.log(
    `  ${CASCADED}: -> FAILED with [ack] failReason (acknowledged abandon)`,
  );

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  await prisma.wcVideo.update({
    where: { id: ORIGINAL },
    data: { status: "SEO_DONE", failReason: null },
  });
  await prisma.wcVideo.update({
    where: { id: CASCADED },
    data: {
      status: "FAILED",
      failReason:
        "[ack] cascade from cmo0bs07k0005qm01znnaftlc — voiceover burned but files lost on container restart; abandoned to prioritise recovery of original. Manually flip to SEO_DONE if you want to recover this one.",
    },
  });

  const aft1 = await prisma.wcVideo.findUnique({
    where: { id: ORIGINAL },
    select: { id: true, status: true, failReason: true },
  });
  const aft2 = await prisma.wcVideo.findUnique({
    where: { id: CASCADED },
    select: { id: true, status: true, failReason: true },
  });
  console.log("\n=== After ===");
  console.log("original:", aft1);
  console.log("cascaded:", aft2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
