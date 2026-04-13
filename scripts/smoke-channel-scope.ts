/**
 * Smoke test for channel scoping — simulates startup for both channels and
 * verifies channelDb returns channel-scoped data.
 */
import "dotenv/config";

async function runFor(channel: "ai-doom-scroll" | "wet-circuit") {
  process.env.CHANNEL = channel;
  // Re-require config / channelDb fresh so the cached env reflects CHANNEL.
  // Use dynamic import w/ cache-bust via query string.
  delete require.cache[require.resolve("../packages/monitor/src/config")];
  delete require.cache[require.resolve("../packages/monitor/src/lib/channelDb")];
  delete require.cache[require.resolve("../packages/monitor/src/lib/channelConfig")];

  const { videos, snapshots, actions, goal, redditPosts } = await import(
    "../packages/monitor/src/lib/channelDb"
  );
  const { getChannelConfig } = await import("../packages/monitor/src/lib/channelConfig");

  const cfg = getChannelConfig();

  console.log(`\n── CHANNEL=${channel} ──`);
  console.log(`  scrapeSubreddits:    ${cfg.scrapeSubreddits.join(", ")}`);
  console.log(`  defaultPost:         r/${cfg.defaultPostSubreddit}`);
  console.log(`  content:             ${cfg.contentDescription.slice(0, 60)}...`);

  const videoCount = await videos.count();
  const snapCount = (await snapshots.findMany()).length;
  const actionCount = await actions.count();
  const g = await goal.find();
  const redditCount = (await redditPosts.findMany()).length;

  console.log(`  videos (${channel === "wet-circuit" ? "WcVideo" : "Video"}):  ${videoCount}`);
  console.log(`  snapshots (scoped):  ${snapCount}`);
  console.log(`  actions (scoped):    ${actionCount}`);
  console.log(`  redditPosts (scoped): ${redditCount}`);
  console.log(`  goal (scoped):       ${g ? `"${g.goal}" tier=${g.autonomyTier}` : "(none)"}`);
}

(async () => {
  // Minimal env required by config.ts for env() to succeed.
  process.env.YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "placeholder";

  await runFor("ai-doom-scroll");

  // Switch YOUTUBE_CHANNEL_ID so the wc pass doesn't fail the cross-check
  // (index.ts's cross-check isn't exercised here — we only hit channelDb).
  await runFor("wet-circuit");
})()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
