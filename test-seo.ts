/**
 * Test script for Stage 6: SEO Generator
 * Run: npx tsx test-seo.ts
 */
import "dotenv/config";
import { PrismaClient, VideoStatus } from "@prisma/client";
import { seoGenerator } from "./src/stages/seoGenerator";
import type { PipelineContext, Script } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 6: SEO Generator Test ===\n");

  const video = await prisma.video.findFirst({
    where: { status: VideoStatus.ASSEMBLY_DONE },
    include: { topic: true },
    orderBy: { createdAt: "desc" },
  });

  if (!video || !video.scriptJson) {
    console.error(
      "No video with ASSEMBLY_DONE status found. Run previous stages first."
    );
    process.exit(1);
  }

  const script = video.scriptJson as unknown as Script;

  console.log(`Video:    ${video.id}`);
  console.log(`Topic:    "${video.topic.title}"`);
  console.log(`Segments: ${script.segments.length}\n`);

  const ctx: PipelineContext = {
    topic: video.topic,
    video,
    script,
    voiceoverUrls: video.voiceoverUrls,
    videoUrl: video.videoPath ?? undefined,
  };

  const result = await seoGenerator(ctx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);

  if (result.data) {
    const seo = result.data as any;
    console.log(`\n── SEO Title ──`);
    console.log(seo.title);
    console.log(`\n── Tags (${seo.tags.length}) ──`);
    console.log(seo.tags.join(", "));
    console.log(`\n── Chapters (${seo.chapters.length}) ──`);
    for (const ch of seo.chapters) {
      console.log(`  ${ch.time} ${ch.label}`);
    }
    console.log(`\n── Description ──`);
    console.log(seo.description);
  }

  // Verify DB state
  const updated = await prisma.video.findUnique({ where: { id: video.id } });
  console.log(`\nDB Video status:  ${updated?.status}`);
  console.log(`DB Video seoTitle: ${updated?.seoTitle}`);
  console.log(`DB Video seoTags:  ${updated?.seoTags?.length} tags`);

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
