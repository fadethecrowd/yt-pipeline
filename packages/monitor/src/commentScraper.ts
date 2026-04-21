import { videos, comments } from "./lib/channelDb";
import { youtube } from "./lib/youtube";
import { liveVideoWhere } from "./lib/queries";
import type { YouTubeComment } from "./lib/types";

/**
 * Scrape new comments for all uploaded videos.
 * Deduplicates by (channel, YouTube comment ID).
 */
export async function scrapeComments(): Promise<YouTubeComment[]> {
  const videoRows = await videos.findMany({
    where: { ...liveVideoWhere },
    select: { id: true, youtubeId: true },
  });

  if (videoRows.length === 0) return [];

  const yt = youtube();
  const allComments: YouTubeComment[] = [];

  for (const video of videoRows) {
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

  // Upsert to avoid duplicates (scoped by channel + youtubeCommentId)
  let inserted = 0;
  for (const c of allComments) {
    const existing = await comments.findByYoutubeCommentId(c.youtubeCommentId);
    if (!existing) {
      await comments.create({
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
