import { prisma } from "./lib/prisma";
import { youtube } from "./lib/youtube";
import type { YouTubeComment } from "./lib/types";

/**
 * Scrape new comments for all uploaded videos.
 * Deduplicates by YouTube comment ID.
 */
export async function scrapeComments(): Promise<YouTubeComment[]> {
  const videos = await prisma.video.findMany({
    where: { youtubeId: { not: null } },
    select: { id: true, youtubeId: true },
  });

  if (videos.length === 0) return [];

  const yt = youtube();
  const allComments: YouTubeComment[] = [];

  for (const video of videos) {
    try {
      const res = await yt.commentThreads.list({
        part: ["snippet"],
        videoId: video.youtubeId!,
        maxResults: 100,
        order: "time",
      });

      for (const thread of res.data.items ?? []) {
        const snippet = thread.snippet?.topLevelComment?.snippet;
        if (!snippet) continue;

        allComments.push({
          youtubeCommentId: thread.snippet!.topLevelComment!.id!,
          videoId: video.id,
          authorName: snippet.authorDisplayName ?? "Unknown",
          authorChannel: snippet.authorChannelUrl ?? undefined,
          text: snippet.textDisplay ?? "",
          likeCount: snippet.likeCount ?? 0,
          publishedAt: new Date(snippet.publishedAt ?? Date.now()),
        });
      }
    } catch (err) {
      console.warn(
        `[commentScraper] Failed for ${video.youtubeId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (allComments.length === 0) return [];

  // Upsert to avoid duplicates
  let inserted = 0;
  for (const c of allComments) {
    const existing = await prisma.comment.findUnique({
      where: { youtubeCommentId: c.youtubeCommentId },
    });
    if (!existing) {
      await prisma.comment.create({
        data: {
          videoId: c.videoId,
          youtubeCommentId: c.youtubeCommentId,
          authorName: c.authorName,
          authorChannel: c.authorChannel,
          text: c.text,
          likeCount: c.likeCount,
          publishedAt: c.publishedAt,
        },
      });
      inserted++;
    }
  }

  console.log(
    `[commentScraper] Scraped ${allComments.length} comments, ${inserted} new`,
  );
  return allComments;
}
