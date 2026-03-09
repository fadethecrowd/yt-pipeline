/**
 * Test script for Stage 1: Topic Discovery
 * Run: npx ts-node test-discovery.ts
 *   or: npx tsx test-discovery.ts
 */
import "dotenv/config";
import { PrismaClient, TopicStatus } from "@prisma/client";
import { topicDiscovery } from "./src/stages/topicDiscovery";
import type { PipelineContext } from "./src/types";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Stage 1: Topic Discovery Test ===\n");

  // Count topics before
  const beforeCount = await prisma.topic.count();
  console.log(`Topics in DB before: ${beforeCount}\n`);

  // Run discovery with a dummy context (topicDiscovery ignores ctx)
  const dummyCtx = {} as PipelineContext;
  const result = await topicDiscovery(dummyCtx);

  console.log(`\nStage result:`);
  console.log(`  success:    ${result.success}`);
  console.log(`  durationMs: ${result.durationMs}`);
  if (result.error) console.log(`  error:      ${result.error}`);
  if (result.data) {
    const topic = result.data as any;
    console.log(`  topic:      "${topic.title}"`);
    console.log(`  source:     ${topic.source}`);
    console.log(`  score:      ${topic.score}`);
    console.log(`  url:        ${topic.url}`);
    console.log(`  status:     ${topic.status}`);
  }

  // Count topics after
  const afterCount = await prisma.topic.count();
  console.log(`\nTopics in DB after: ${afterCount} (+${afterCount - beforeCount} new)`);

  // Show top 10 topics
  const top = await prisma.topic.findMany({
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: 10,
  });

  console.log(`\n--- Top ${top.length} Topics ---`);
  for (const t of top) {
    const status = t.status.padEnd(10);
    const score = (t.score ?? 0).toFixed(3).padStart(5);
    console.log(`  [${status}] ${score}  ${t.source.padEnd(13)} ${t.title.slice(0, 80)}`);
  }

  console.log("\n=== Done ===");
}

main()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
