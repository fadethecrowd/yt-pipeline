/**
 * Pre-migration duplicate check.
 *
 * The monitor channel-pluggability migration tightens several @@unique
 * constraints. If any existing rows would violate the new constraints,
 * the migration will fail at apply time. This script checks for those
 * conflicts in advance so we can see them before running the migration.
 *
 * New constraints being introduced:
 *   Comment:     @@unique([channel, youtubeCommentId])   (was: @@unique([youtubeCommentId]))
 *   DigestLog:   @@unique([channel, period, createdAt])  (was: none on period)
 *   TopicSeed:   @@unique([channel, title, source])      (was: none)
 *   RedditPost:  @@unique([channel, videoId, subreddit]) (was: none)
 *   ChannelGoal: @@unique([channel])                     (was: none)
 *
 * Since the column `channel` does not exist yet, all rows will be treated as
 * channel='ai-doom-scroll' (the default). So duplicates under each new
 * constraint are: rows that have the same key set within the existing AI Doom
 * Scroll data.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const results: Record<string, unknown> = {};

  // 1. Comment: duplicate youtubeCommentId (already enforced as unique, but sanity-check)
  const dupComments = await prisma.$queryRaw<{ youtubeCommentId: string; count: bigint }[]>`
    SELECT "youtubeCommentId", COUNT(*) AS count
    FROM "Comment"
    GROUP BY "youtubeCommentId"
    HAVING COUNT(*) > 1
    LIMIT 20;
  `;
  results.Comment_dup_youtubeCommentId = dupComments;

  // 2. DigestLog: duplicate (period, createdAt) — will all collapse under channel='ai-doom-scroll'
  const dupDigest = await prisma.$queryRaw<{ period: string; createdAt: Date; count: bigint }[]>`
    SELECT "period", "createdAt", COUNT(*) AS count
    FROM "DigestLog"
    GROUP BY "period", "createdAt"
    HAVING COUNT(*) > 1
    LIMIT 20;
  `;
  results.DigestLog_dup_period_createdAt = dupDigest;

  // 3. TopicSeed: duplicate (title, source)
  const dupSeed = await prisma.$queryRaw<{ title: string; source: string; count: bigint }[]>`
    SELECT "title", "source", COUNT(*) AS count
    FROM "TopicSeed"
    GROUP BY "title", "source"
    HAVING COUNT(*) > 1
    LIMIT 20;
  `;
  results.TopicSeed_dup_title_source = dupSeed;

  // 4. RedditPost: duplicate (videoId, subreddit)
  const dupRedditPost = await prisma.$queryRaw<{ videoId: string; subreddit: string; count: bigint }[]>`
    SELECT "videoId", "subreddit", COUNT(*) AS count
    FROM "RedditPost"
    GROUP BY "videoId", "subreddit"
    HAVING COUNT(*) > 1
    LIMIT 20;
  `;
  results.RedditPost_dup_videoId_subreddit = dupRedditPost;

  // 5. ChannelGoal: count — must be 0 or 1 to satisfy @@unique([channel])
  const goalCount = await prisma.channelGoal.count();
  results.ChannelGoal_row_count = goalCount;

  // Row counts for context
  results.row_counts = {
    VideoSnapshot: await prisma.videoSnapshot.count(),
    Comment: await prisma.comment.count(),
    MonitorAction: await prisma.monitorAction.count(),
    DigestLog: await prisma.digestLog.count(),
    ChannelGoal: goalCount,
    TopicSeed: await prisma.topicSeed.count(),
    RedditPost: await prisma.redditPost.count(),
  };

  console.log(
    JSON.stringify(
      results,
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
