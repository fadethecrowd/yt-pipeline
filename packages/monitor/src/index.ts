import "dotenv/config";
import { prisma } from "./lib/prisma";
import { env } from "./config";
import { pollVideoMetrics } from "./poller";
import { scrapeComments } from "./commentScraper";
import { evaluate } from "./decisionEngine";
import { executeDecisions } from "./executor";
import { sendDailyDigest, shouldSendDigest } from "./digest";

const DAILY_MS = 24 * 60 * 60 * 1000;

async function tick(): Promise<void> {
  const start = Date.now();
  console.log(`[monitor] ═══ Tick at ${new Date().toISOString()} ═══`);

  // 1. Poll metrics
  const metrics = await pollVideoMetrics();

  // 2. Scrape comments
  await scrapeComments();

  // 3. Evaluate & act
  const decisions = await evaluate(metrics);
  if (decisions.length > 0) {
    await executeDecisions(decisions);
  }

  // 4. Daily digest (if due)
  if (await shouldSendDigest("daily", DAILY_MS)) {
    await sendDailyDigest();
  }

  const elapsed = Date.now() - start;
  console.log(`[monitor] ═══ Tick complete (${elapsed}ms) ═══\n`);
}

async function main(): Promise<void> {
  const config = env();
  console.log(
    `[monitor] Starting with poll interval ${config.POLL_INTERVAL_MS}ms`,
  );

  // Run immediately, then on interval
  await tick();
  setInterval(() => {
    tick().catch((err) => {
      console.error("[monitor] Tick failed:", err);
    });
  }, config.POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[monitor] Fatal:", err);
  process.exit(1);
}).finally(() => {
  // Keep process alive for setInterval; disconnect on fatal exit
  process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
