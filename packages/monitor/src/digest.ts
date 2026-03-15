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

  const message = [
    `📊 *Daily Digest* — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Total views: ${totalViews} (+${totalDelta})`,
    `Videos tracked: ${entries.length}`,
    "",
    ...lines,
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
