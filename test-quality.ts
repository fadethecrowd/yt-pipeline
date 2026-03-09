/**
 * Test script for Stage 3: Quality Gate
 * Run: npx tsx test-quality.ts
 */
import "dotenv/config";
import { PrismaClient, VideoStatus } from "@prisma/client";
import { qualityGate } from "./src/stages/qualityGate";
import type { PipelineContext, Script } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 3: Quality Gate Test ===\n");

  // Find a video with SCRIPT_DONE status and its topic
  const video = await prisma.video.findFirst({
    where: { status: VideoStatus.SCRIPT_DONE },
    include: { topic: true },
    orderBy: { createdAt: "desc" },
  });

  if (!video || !video.scriptJson) {
    console.error("No video with SCRIPT_DONE status found. Run test-script.ts first.");
    process.exit(1);
  }

  console.log(`Video:  ${video.id}`);
  console.log(`Topic:  "${video.topic.title}"`);
  console.log(`Script: ${(video.scriptJson as any).segments?.length ?? 0} segments\n`);

  // Build context
  const ctx: PipelineContext = {
    topic: video.topic,
    video,
    script: video.scriptJson as unknown as Script,
  };

  // Run quality gate
  const result = await qualityGate(ctx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);

  if (result.data) {
    const qr = result.data as any;
    console.log(`  score:      ${qr.score}/100`);
    console.log(`  verdict:    ${qr.verdict}`);
  }

  // Verify DB state
  const updated = await prisma.video.findUnique({ where: { id: video.id } });
  console.log(`\nDB Video status:       ${updated?.status}`);
  console.log(`DB Video qualityScore: ${updated?.qualityScore}`);
  if (updated?.failReason) console.log(`DB Video failReason:   ${updated.failReason}`);

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
