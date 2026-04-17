/**
 * List all topics in the Topic Library.
 *
 * Usage:
 *   npx tsx scripts/listLibraryTopics.ts                  # all
 *   npx tsx scripts/listLibraryTopics.ts --channel ai-doom # filtered
 *   npx tsx scripts/listLibraryTopics.ts --status PENDING  # by status
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const channel = arg("channel");
  const status = arg("status");

  const where: Record<string, unknown> = {};
  if (channel) where.channel = channel;
  if (status) where.status = status;

  const entries = await prisma.topicLibrary.findMany({
    where,
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      channel: true,
      title: true,
      priority: true,
      status: true,
      source: true,
      createdAt: true,
    },
  });

  console.log(`Topic Library — ${entries.length} entries${channel ? ` (channel=${channel})` : ""}${status ? ` (status=${status})` : ""}\n`);

  if (entries.length === 0) {
    console.log("(empty)");
    return;
  }

  for (const e of entries) {
    console.log(
      `  [${e.status.padEnd(8)}] p=${String(e.priority).padStart(2)} | ${e.channel.padEnd(12)} | ${e.createdAt.toISOString().slice(0, 10)} | "${e.title.slice(0, 60)}"`,
    );
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
