// Only load .env file in development — Railway injects env vars directly
if (!process.env.RAILWAY_ENVIRONMENT) {
  require("dotenv/config");
}
import { verifyChannel, CHANNELS } from "@yt-pipeline/pipeline-core";
import { prisma } from "./lib/prisma";
import { goal as goalDb } from "./lib/channelDb";
import { env } from "./config";
import { pollVideoMetrics } from "./poller";
import { scrapeComments } from "./commentScraper";
import { evaluate } from "./decisionEngine";
import { executeDecisions } from "./executor";
import { sendDailyDigest, shouldSendDigest } from "./digest";
import { startBot, setLastTickTime } from "./telegram";
import { scrapeRedditTopics } from "./redditScraper";
import { detectLifecycleEvents } from "./lifecycleDetector";
import { parseMonitorMode } from "./lib/monitorMode";
import { realHealthDeps, startHealthLoop } from "./healthDeps";
import { startAuthorizationTick } from "./authorizationTick";
import { generateRedditPosts } from "./redditPoster";

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

  // 3b. Lifecycle events (community post, end screen, re-promotion)
  try {
    const lifecycleDecisions = await detectLifecycleEvents();
    if (lifecycleDecisions.length > 0) {
      await executeDecisions(lifecycleDecisions);
    }
  } catch (err) {
    console.error("[monitor] Lifecycle detection failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  // 3c. Reddit auto-posting for published videos (sends Telegram approval)
  try {
    const redditDecisions = await generateRedditPosts();
    if (redditDecisions.length > 0) {
      await executeDecisions(redditDecisions);
    }
  } catch (err) {
    console.error("[monitor] Reddit posting failed (non-fatal):", err instanceof Error ? err.message : err);
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
  // ── Master execution gate ────────────────────────────────────────────
  //
  // Before ANY monitoring side effect: no channel verification (a YouTube
  // call), no Telegram bot (which announces itself on startup), no tick, no
  // interval, no monitoring query. MONITOR_AI_ENABLED never gated this — it
  // only ever suppressed Claude calls, so a monitor with AI off still ran.
  //
  // Fail-closed: unset means DISABLED, and an unrecognised value throws rather
  // than falling back to a mode that does work.
  const mode = parseMonitorMode(process.env.MONITOR_MODE);
  if (mode === "DISABLED") {
    console.log(
      `[monitor] MONITOR_MODE=${process.env.MONITOR_MODE ?? "<unset>"} — ` +
      "monitor execution disabled; exiting without starting any monitoring work",
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  const config = env();
  const serviceLabel = `monitor:${config.CHANNEL}`;
  const expected = CHANNELS[config.CHANNEL];

  await verifyChannel(expected, serviceLabel);

  if (mode === "HEALTH_ONLY") {
    // Deterministic health checks only. The legacy tick — metrics, comments,
    // decision engine, executor, lifecycle, Reddit — is never reached, so the
    // write-capable machinery is not merely disabled but unreachable.
    console.log(
      `[${serviceLabel}] MONITOR_MODE=health_only — deterministic health checks only; ` +
      "legacy monitoring, AI decisions and all YouTube writes are unreachable",
    );
    const deps = realHealthDeps(config.CHANNEL);
    const loop = startHealthLoop(config.CHANNEL, deps, config.POLL_INTERVAL_MS);
    await loop.runNow();
    // Authorization is not a monitoring side effect — no YouTube call, no
    // Claude call, no comment read — so it runs here too, behind its own
    // independent SCHEDULER_ENABLED gate.
    const scheduler = startAuthorizationTick(config.CHANNEL);
    process.on("SIGTERM", async () => {
      loop.stop();
      scheduler.stop();
      await prisma.$disconnect();
      process.exit(0);
    });
    return;
  }

  console.log(`[${serviceLabel}] MONITOR_MODE=active — full legacy monitoring`);

  if (config.YOUTUBE_CHANNEL_ID !== expected.id) {
    throw new Error(
      `[${serviceLabel}] YOUTUBE_CHANNEL_ID (${config.YOUTUBE_CHANNEL_ID}) does not match pinned channel ${expected.id} for CHANNEL=${config.CHANNEL}`,
    );
  }

  console.log(
    `[${serviceLabel}] Starting with poll interval ${config.POLL_INTERVAL_MS}ms (${config.POLL_INTERVAL_MS / 60_000} min)`,
  );
  if (config.MONITOR_AI_ENABLED) {
    console.log(
      `[${serviceLabel}] AI enabled — daily Claude call limit: ${config.MONITOR_AI_DAILY_CALL_LIMIT}`,
    );
  } else {
    console.log(
      `[${serviceLabel}] AI disabled (MONITOR_AI_ENABLED is not "true") — all Claude calls will be skipped`,
    );
  }

  // Check for ChannelGoal for this channel
  const goal = await goalDb.find();
  if (!goal) {
    console.warn(
      `[${serviceLabel}] ⚠ No ChannelGoal found for channel=${config.CHANNEL}. Decision engine needs a goal to evaluate videos effectively. Send /goal via Telegram to set one.`,
    );
  } else {
    console.log(`[${serviceLabel}] ChannelGoal loaded: "${goal.goal}" (tier ${goal.autonomyTier})`);
  }

  // Start Telegram bot listener
  startBot();

  startAuthorizationTick(config.CHANNEL);

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
