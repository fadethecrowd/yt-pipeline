/**
 * Test script for Stage 2: Script Generator
 * Run: npx tsx test-script.ts
 */
import "dotenv/config";
import { PrismaClient, TopicStatus, VideoStatus } from "@prisma/client";
import { scriptGenerator } from "./src/stages/scriptGenerator";
import type { PipelineContext } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 2: Script Generator Test ===\n");

  // 1. Find the top APPROVED topic
  let topic = await prisma.topic.findFirst({
    where: { status: TopicStatus.APPROVED },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
  });

  // If none approved, grab a DISCOVERED one and approve it
  if (!topic) {
    topic = await prisma.topic.findFirst({
      where: { status: TopicStatus.DISCOVERED },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    });
    if (topic) {
      topic = await prisma.topic.update({
        where: { id: topic.id },
        data: { status: TopicStatus.APPROVED },
      });
    }
  }

  if (!topic) {
    console.error("No topics available. Run test-discovery.ts first.");
    process.exit(1);
  }

  console.log(`Topic: "${topic.title}"`);
  console.log(`Source: ${topic.source} | Score: ${topic.score}`);
  console.log(`URL: ${topic.url}\n`);

  // 2. Create a Video record
  const video = await prisma.video.create({
    data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING },
  });
  console.log(`Video record created: ${video.id}\n`);

  // 3. Run script generator
  const ctx: PipelineContext = { topic, video };
  const result = await scriptGenerator(ctx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);

  if (result.success && result.data) {
    const script = result.data as any;
    console.log(`\n--- Generated Script ---`);
    console.log(`Hook (first 200 chars):\n  ${script.hook.slice(0, 200)}...\n`);
    console.log(`Segments (${script.segments.length}):`);
    for (const seg of script.segments) {
      console.log(`  [${seg.segmentIndex}] "${seg.title}" (~${seg.duration_seconds}s)`);
      console.log(`      Narration: ${seg.narration.slice(0, 100)}...`);
      console.log(`      Visual:    ${seg.visual_prompt.slice(0, 100)}...`);
    }
    console.log(`\nCTA: ${script.cta.slice(0, 200)}`);
    console.log(`Total duration: ~${script.estimatedTotalDuration}s`);
  }

  // 4. Verify DB state
  const updated = await prisma.video.findUnique({ where: { id: video.id } });
  console.log(`\nDB Video status: ${updated?.status}`);
  console.log(`DB scriptJson:   ${updated?.scriptJson ? "stored" : "missing"}`);

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
