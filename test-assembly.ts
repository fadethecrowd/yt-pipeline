/**
 * Test script for Stage 5: Video Assembly (Pexels + ffmpeg)
 * Run: npx tsx test-assembly.ts
 */
import "dotenv/config";
import { PrismaClient, VideoStatus } from "@prisma/client";
import { videoAssembly } from "./src/stages/videoAssembly";
import type { PipelineContext, Script } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 5: Video Assembly Test ===\n");

  // Find the latest video with VOICEOVER_DONE status
  const video = await prisma.video.findFirst({
    where: { status: VideoStatus.VOICEOVER_DONE },
    include: { topic: true },
    orderBy: { createdAt: "desc" },
  });

  if (!video || !video.scriptJson || !video.voiceoverPath) {
    console.error(
      "No video with VOICEOVER_DONE status found. Run previous stages first."
    );
    process.exit(1);
  }

  const script = video.scriptJson as unknown as Script;

  console.log(`Video:         ${video.id}`);
  console.log(`Topic:         "${video.topic.title}"`);
  console.log(`Segments:      ${script.segments.length}`);
  console.log(`VoiceoverPath: ${video.voiceoverPath}\n`);

  for (const seg of script.segments) {
    console.log(
      `  [${seg.segmentIndex}] "${seg.title}" — ${seg.duration_seconds}s`
    );
    console.log(
      `      visual: "${seg.visual_prompt.slice(0, 60)}..."`
    );
  }
  console.log();

  // Build context
  const ctx: PipelineContext = {
    topic: video.topic,
    video,
    script,
    voiceoverUrls: video.voiceoverUrls,
  };

  // Run assembly stage
  const result = await videoAssembly(ctx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);
  if (result.data) {
    const d = result.data as any;
    console.log(`  videoPath:  ${d.videoPath}`);
  }

  // Verify DB state
  const updated = await prisma.video.findUnique({
    where: { id: video.id },
  });
  console.log(`\nDB Video status:    ${updated?.status}`);
  console.log(`DB Video videoPath: ${updated?.videoPath}`);

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
