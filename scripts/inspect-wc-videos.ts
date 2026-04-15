import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const ids = ["cmo0bs07k0005qm01znnaftlc", "cmo0cph2p0005ms01pvpwht3k"];
  for (const id of ids) {
    const v = await prisma.wcVideo.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        seoTitle: true,
        videoPath: true,
        voiceoverPath: true,
        voiceoverUrls: true,
        youtubeId: true,
        failReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    console.log(`\n=== ${id} ===`);
    console.log(v ?? "(not found)");
  }

  const allFailed = await prisma.wcVideo.findMany({
    where: { status: "FAILED" },
    select: { id: true, status: true, failReason: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });
  console.log(`\n=== All FAILED wc_videos (top 10 by updatedAt) ===`);
  for (const v of allFailed) console.log(v);
}

main().catch(console.error).finally(() => prisma.$disconnect());
