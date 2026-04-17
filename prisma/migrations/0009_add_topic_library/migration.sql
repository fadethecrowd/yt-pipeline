-- Topic Library: curated topics that pipelines can pull from instead of
-- discovering new ones. Shared across channels, keyed by channel string.

CREATE TYPE "TopicLibraryStatus" AS ENUM ('PENDING', 'USED', 'ARCHIVED');

CREATE TABLE "topic_library" (
    "id"        TEXT NOT NULL,
    "channel"   TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "source"    TEXT,
    "url"       TEXT,
    "summary"   TEXT,
    "priority"  INTEGER NOT NULL DEFAULT 0,
    "status"    "TopicLibraryStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topic_library_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "topic_library_channel_status_priority_idx"
  ON "topic_library" ("channel", "status", "priority" DESC);
