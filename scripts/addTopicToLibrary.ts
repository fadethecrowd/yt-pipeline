/**
 * Add a topic to the Topic Library.
 *
 * Usage:
 *   npx tsx scripts/addTopicToLibrary.ts \
 *     --channel wet-circuit \
 *     --title "Pond Prowler 10: Max Weight Before It Sinks" \
 *     --source manual \
 *     --priority 5 \
 *     --summary "Optional summary text"
 *
 *   npx tsx scripts/addTopicToLibrary.ts \
 *     --channel ai-doom \
 *     --title "GPT-5 Evaluation Leaked" \
 *     --url "https://example.com/article"
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
  const title = arg("title");
  const source = arg("source") ?? "manual";
  const url = arg("url") ?? null;
  const summary = arg("summary") ?? null;
  const priority = parseInt(arg("priority") ?? "0", 10);

  if (!channel || !title) {
    console.log("Usage: npx tsx scripts/addTopicToLibrary.ts --channel <ai-doom|wet-circuit> --title <title> [--source manual] [--url <url>] [--summary <text>] [--priority <n>]");
    process.exit(1);
  }
  if (channel !== "ai-doom" && channel !== "wet-circuit") {
    console.error(`Invalid channel "${channel}" — must be "ai-doom" or "wet-circuit"`);
    process.exit(1);
  }

  const entry = await prisma.topicLibrary.create({
    data: { channel, title, source, url, summary, priority },
  });

  console.log("Created:");
  console.log(entry);
}

main().catch(console.error).finally(() => prisma.$disconnect());
