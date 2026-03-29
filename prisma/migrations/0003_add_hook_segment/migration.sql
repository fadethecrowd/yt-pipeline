-- AlterTable: add hookSegment to Video
ALTER TABLE "Video" ADD COLUMN "hookSegment" TEXT;

-- CreateEnum: new action types
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ActionType') THEN
    CREATE TYPE "ActionType" AS ENUM ('PIN_COMMENT', 'HEART_COMMENT', 'REPLY_COMMENT', 'UPDATE_TITLE', 'UPDATE_DESCRIPTION', 'UPDATE_TAGS', 'REGENERATE_THUMBNAIL', 'COMMUNITY_POST', 'END_SCREEN', 'REPROMOTE', 'REDDIT_POST', 'GENERATE_SHORT', 'ALERT');
  ELSE
    ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'REDDIT_POST';
    ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'GENERATE_SHORT';
  END IF;
END $$;

-- CreateTable: RedditPost
CREATE TABLE IF NOT EXISTS "RedditPost" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "subreddit" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "redditPostId" TEXT,
    "redditUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "RedditPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RedditPost_videoId_idx" ON "RedditPost"("videoId");
CREATE INDEX IF NOT EXISTS "RedditPost_status_idx" ON "RedditPost"("status");
