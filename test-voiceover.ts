/**
 * Test script for Stage 4: Voiceover (ElevenLabs TTS)
 * Run: npx tsx test-voiceover.ts
 */
import "dotenv/config";
import { PrismaClient, VideoStatus } from "@prisma/client";
import { voiceover } from "./src/stages/voiceover";
import type { PipelineContext, Script } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 4: Voiceover Test ===\n");

  // Find the latest video with VOICEOVER_PENDING status
  const video = await prisma.video.findFirst({
    where: { status: VideoStatus.VOICEOVER_PENDING },
    include: { topic: true },
    orderBy: { createdAt: "desc" },
  });

  if (!video || !video.scriptJson) {
    console.error(
      "No video with VOICEOVER_PENDING status found. Run previous stages first."
    );
    process.exit(1);
  }

  const script = video.scriptJson as unknown as Script;

  console.log(`Video:    ${video.id}`);
  console.log(`Topic:    "${video.topic.title}"`);
  console.log(`Segments: ${script.segments.length}\n`);

  for (const seg of script.segments) {
    console.log(
      `  [${seg.segmentIndex}] "${seg.title}" — ${seg.narration.length} chars`
    );
  }
  console.log();

  // Build context
  const ctx: PipelineContext = {
    topic: video.topic,
    video,
    script,
  };

  // Run voiceover stage
  const result = await voiceover(ctx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);

  if (result.data && Array.isArray(result.data)) {
    console.log(`\n  Generated files:`);
    for (const r of result.data as any[]) {
      console.log(`    segment-${r.segmentIndex}: ${r.url}`);
    }
  }

  // Verify DB state
  const updated = await prisma.video.findUnique({ where: { id: video.id } });
  console.log(`\nDB Video status:        ${updated?.status}`);
  console.log(`DB Video voiceoverPath: ${updated?.voiceoverPath}`);
  console.log(`DB Video voiceoverUrls: ${updated?.voiceoverUrls?.length} files`);

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
