import { prisma } from "./lib/prisma";
import { sendTelegram } from "./telegram";
import type { DigestEntry } from "./lib/types";

/**
 * Build and send a daily performance digest via Telegram.
 */
export async function sendDailyDigest(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const videos = await prisma.video.findMany({
    where: { youtubeId: { not: null } },
    include: {
      topic: { select: { title: true } },
      snapshots: {
        orderBy: { createdAt: "desc" },
        take: 2,
      },
    },
  });

  const entries: DigestEntry[] = [];

  for (const video of videos) {
    const [latest, prev] = video.snapshots;
    if (!latest) continue;

    entries.push({
      videoTitle: video.seoTitle ?? video.topic.title,
      youtubeId: video.youtubeId!,
      views: latest.views,
      viewsDelta: prev ? latest.views - prev.views : latest.views,
      likes: latest.likes,
      likesDelta: prev ? latest.likes - prev.likes : latest.likes,
      comments: latest.comments,
      commentsDelta: prev ? latest.comments - prev.comments : latest.comments,
    });
  }

  if (entries.length === 0) {
    console.log("[digest] No videos to report");
    return;
  }

  // Sort by views descending
  entries.sort((a, b) => b.views - a.views);

  const lines = entries.map(
    (e) =>
      `*${e.videoTitle}*\n` +
      `  👁 ${e.views} (+${e.viewsDelta}) | ` +
      `👍 ${e.likes} (+${e.likesDelta}) | ` +
      `💬 ${e.comments} (+${e.commentsDelta})`,
  );

  const totalViews = entries.reduce((s, e) => s + e.views, 0);
  const totalDelta = entries.reduce((s, e) => s + e.viewsDelta, 0);

  // ── Reddit posts this week ──────────────────────────────────────────
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentRedditPosts = await prisma.redditPost.findMany({
    where: { status: "POSTED", postedAt: { gte: weekAgo } },
  });

  const redditLines: string[] = [];
  if (recentRedditPosts.length > 0) {
    redditLines.push("", "*Reddit Posts (7d)*");
    for (const rp of recentRedditPosts) {
      redditLines.push(`  r/${rp.subreddit}: ${rp.title.slice(0, 60)}`);
    }
  }

  // ── Shorts this week ──────────────────────────────────────────────
  const recentShorts = await prisma.monitorAction.findMany({
    where: {
      type: "GENERATE_SHORT",
      status: "EXECUTED",
      executedAt: { gte: weekAgo },
    },
  });

  const shortsLines: string[] = [];
  if (recentShorts.length > 0) {
    shortsLines.push("", `*Shorts Uploaded (7d):* ${recentShorts.length}`);

    // Find best performing Short vs its parent
    for (const shortAction of recentShorts) {
      const parentVideo = await prisma.video.findUnique({
        where: { id: shortAction.videoId },
        select: { seoTitle: true, youtubeId: true },
      });
      if (parentVideo) {
        const resultUrl = shortAction.result?.match(/https:\/\/youtube\.com\/shorts\/\S+/)?.[0];
        if (resultUrl) {
          shortsLines.push(`  "${parentVideo.seoTitle?.slice(0, 40) ?? "Unknown"}" → ${resultUrl}`);
        }
      }
    }
  }

  const message = [
    `📊 *Daily Digest* — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Total views: ${totalViews} (+${totalDelta})`,
    `Videos tracked: ${entries.length}`,
    "",
    ...lines,
    ...redditLines,
    ...shortsLines,
  ].join("\n");

  await sendTelegram(message);

  await prisma.digestLog.create({
    data: {
      period: "daily",
      videoCount: entries.length,
      summary: `${totalViews} total views (+${totalDelta})`,
      sentVia: "telegram",
    },
  });

  console.log(`[digest] Daily digest sent — ${entries.length} videos`);
}

/**
 * Check if enough time has passed since the last digest.
 */
export async function shouldSendDigest(
  period: string,
  intervalMs: number,
): Promise<boolean> {
  const last = await prisma.digestLog.findFirst({
    where: { period },
    orderBy: { createdAt: "desc" },
  });
  if (!last) return true;
  return Date.now() - last.createdAt.getTime() > intervalMs;
}
