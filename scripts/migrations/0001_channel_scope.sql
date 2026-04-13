-- Monitor channel-pluggability migration.
--
-- Adds a `channel` column (default 'ai-doom-scroll') to every monitor-owned
-- table so a single Postgres instance can host state for multiple channel
-- deploys (CHANNEL=ai-doom-scroll vs CHANNEL=wet-circuit).
--
-- Existing rows backfill to 'ai-doom-scroll' automatically via the DEFAULT.
-- Step 2 of rollout (separate migration) will drop this default so future
-- inserts must specify channel explicitly.
--
-- FK from VideoSnapshot -> Video is dropped so a snapshot's videoId can
-- reference either `Video` (ai-doom-scroll) or `wc_video` (wet-circuit).
-- App-level integrity enforced in packages/monitor/src/lib/channelDb.ts.
--
-- Apply via:
--   npx prisma db execute \
--     --file scripts/migrations/0001_channel_scope.sql \
--     --schema packages/monitor/prisma/schema.prisma
--
-- Safe to re-run: every statement uses IF EXISTS / IF NOT EXISTS.

BEGIN;

-- ── 1. VideoSnapshot ──────────────────────────────────────────────────────
ALTER TABLE "VideoSnapshot"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

ALTER TABLE "VideoSnapshot"
  DROP CONSTRAINT IF EXISTS "VideoSnapshot_videoId_fkey";

DROP INDEX IF EXISTS "VideoSnapshot_videoId_createdAt_idx";

CREATE INDEX IF NOT EXISTS "VideoSnapshot_channel_videoId_createdAt_idx"
  ON "VideoSnapshot" ("channel", "videoId", "createdAt");

-- ── 2. Comment ────────────────────────────────────────────────────────────
ALTER TABLE "Comment"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

DROP INDEX IF EXISTS "Comment_youtubeCommentId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Comment_channel_youtubeCommentId_key"
  ON "Comment" ("channel", "youtubeCommentId");

DROP INDEX IF EXISTS "Comment_videoId_publishedAt_idx";

CREATE INDEX IF NOT EXISTS "Comment_channel_videoId_publishedAt_idx"
  ON "Comment" ("channel", "videoId", "publishedAt");

-- ── 3. MonitorAction ──────────────────────────────────────────────────────
ALTER TABLE "MonitorAction"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

DROP INDEX IF EXISTS "MonitorAction_videoId_idx";
DROP INDEX IF EXISTS "MonitorAction_status_idx";

CREATE INDEX IF NOT EXISTS "MonitorAction_channel_videoId_idx"
  ON "MonitorAction" ("channel", "videoId");

CREATE INDEX IF NOT EXISTS "MonitorAction_channel_status_idx"
  ON "MonitorAction" ("channel", "status");

CREATE INDEX IF NOT EXISTS "MonitorAction_channel_videoId_type_status_idx"
  ON "MonitorAction" ("channel", "videoId", "type", "status");

-- ── 4. DigestLog ──────────────────────────────────────────────────────────
ALTER TABLE "DigestLog"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

CREATE UNIQUE INDEX IF NOT EXISTS "DigestLog_channel_period_createdAt_key"
  ON "DigestLog" ("channel", "period", "createdAt");

CREATE INDEX IF NOT EXISTS "DigestLog_channel_period_createdAt_idx"
  ON "DigestLog" ("channel", "period", "createdAt");

-- ── 5. ChannelGoal ────────────────────────────────────────────────────────
ALTER TABLE "ChannelGoal"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelGoal_channel_key"
  ON "ChannelGoal" ("channel");

-- ── 6. TopicSeed ──────────────────────────────────────────────────────────
ALTER TABLE "TopicSeed"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

DROP INDEX IF EXISTS "TopicSeed_createdAt_idx";

CREATE INDEX IF NOT EXISTS "TopicSeed_channel_createdAt_idx"
  ON "TopicSeed" ("channel", "createdAt");

-- ── 7. RedditPost ─────────────────────────────────────────────────────────
ALTER TABLE "RedditPost"
  ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ai-doom-scroll';

DROP INDEX IF EXISTS "RedditPost_videoId_idx";
DROP INDEX IF EXISTS "RedditPost_status_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "RedditPost_channel_videoId_subreddit_key"
  ON "RedditPost" ("channel", "videoId", "subreddit");

CREATE INDEX IF NOT EXISTS "RedditPost_channel_videoId_idx"
  ON "RedditPost" ("channel", "videoId");

CREATE INDEX IF NOT EXISTS "RedditPost_channel_status_idx"
  ON "RedditPost" ("channel", "status");

COMMIT;
