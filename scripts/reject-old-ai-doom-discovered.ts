/**
 * One-time AI Doom Scroll topic discovery cleanup.
 *
 * Marks all current Topic rows with status='DISCOVERED' as 'REJECTED' so
 * the new SOURCE_WEIGHTS / NEGATIVE_KEYWORDS / TECHNICAL_CORE_KEYWORDS
 * rules apply to fresh fetches only. Old high-scoring funding/PR-style
 * topics will not surface as fallback in pickBestTopic().
 *
 * Read-only by default. Pass --apply to write.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const candidates = await prisma.topic.findMany({
    where: { status: "DISCOVERED" },
    select: { id: true, title: true, score: true, source: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`=== Topic rows currently status='DISCOVERED' (AI Doom Scroll) ===`);
  console.log(`Count: ${candidates.length}\n`);
  for (const c of candidates.slice(0, 25)) {
    console.log(
      `  ${c.createdAt.toISOString()} | score=${c.score ?? "?"} | source=${c.source} | "${c.title.slice(0, 80)}"`,
    );
  }
  if (candidates.length > 25) {
    console.log(`  ... and ${candidates.length - 25} more`);
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to mark all ${candidates.length} as REJECTED.`);
    return;
  }

  const result = await prisma.topic.updateMany({
    where: { status: "DISCOVERED" },
    data: { status: "REJECTED" },
  });

  console.log(`\n=== Applied ===`);
  console.log(`Rows updated: ${result.count}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
