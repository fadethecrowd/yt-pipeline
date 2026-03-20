// Only load .env file in development — Railway injects env vars directly
if (!process.env.RAILWAY_ENVIRONMENT) {
  require("dotenv/config");
}
import { prisma } from "./lib/prisma";
import { env } from "./config";
import { pollVideoMetrics } from "./poller";
import { scrapeComments } from "./commentScraper";
import { evaluate } from "./decisionEngine";
import { executeDecisions } from "./executor";
import { sendDailyDigest, shouldSendDigest } from "./digest";
import { startBot, setLastTickTime } from "./telegram";
import { scrapeRedditTopics } from "./redditScraper";

const DAILY_MS = 24 * 60 * 60 * 1000;
const DIGEST_HOUR_UTC = 14; // ~9 AM EST

let firstTick = true;

async function tick(): Promise<void> {
  const start = Date.now();
  console.log(`[monitor] ═══ Tick at ${new Date().toISOString()} ═══`);

  // 1. Poll metrics
  const metrics = await pollVideoMetrics();

  // 2. Scrape comments
  await scrapeComments();

  // 3. Evaluate & act
  console.log(`[monitor] Starting decision cycle with ${metrics.length} videos`);
  for (const m of metrics) {
    console.log(
      `[monitor]   video=${m.videoId} yt=${m.youtubeId} views=${m.views} likes=${m.likes} comments=${m.comments} ctr=${m.ctr !== undefined ? (m.ctr * 100).toFixed(2) + "%" : "n/a"} avgViewDuration=${m.avgViewDuration ?? "n/a"}`,
    );
  }
  const decisions = await evaluate(metrics);
  if (decisions.length > 0) {
    await executeDecisions(decisions);
  } else {
    console.log(`[monitor] No decisions — skipping executor`);
  }

  // 4. Daily tasks — skip the first tick; only run at the scheduled hour
  if (!firstTick && new Date().getUTCHours() === DIGEST_HOUR_UTC) {
    try {
      if (await shouldSendDigest("daily", DAILY_MS)) {
        await sendDailyDigest();
      }
    } catch (err) {
      console.error("[monitor] Digest send failed (non-fatal):", err instanceof Error ? err.message : err);
    }

    // 5. Reddit topic scraper (daily)
    try {
      await scrapeRedditTopics();
    } catch (err) {
      console.error("[monitor] Reddit scrape failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
  firstTick = false;

  setLastTickTime(new Date());
  const elapsed = Date.now() - start;
  console.log(`[monitor] ═══ Tick complete (${elapsed}ms) ═══\n`);
}

async function main(): Promise<void> {
  const config = env();
  console.log(
    `[monitor] Starting with poll interval ${config.POLL_INTERVAL_MS}ms`,
  );

  // Check for ChannelGoal
  const goal = await prisma.channelGoal.findFirst({
    orderBy: { updatedAt: "desc" },
  });
  if (!goal) {
    console.warn(
      "[monitor] ⚠ No ChannelGoal found in the database! The decision engine needs a goal to evaluate videos effectively. Send /goal via Telegram to set one.",
    );
  } else {
    console.log(`[monitor] ChannelGoal loaded: "${goal.goal}" (tier ${goal.autonomyTier})`);
  }

  // Start Telegram bot listener
  startBot();

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
