-- Add Shorts classification to VideoSnapshot history.
-- VideoSnapshot is declared in packages/monitor/prisma/schema.prisma only;
-- table name is "VideoSnapshot" (Prisma model-name default, no @@map).
-- New column defaults to false so existing rows are unaffected; future
-- poller inserts will populate it from contentDetails.duration ≤ 60s
-- per packages/monitor/src/lib/videoType.ts.

ALTER TABLE "VideoSnapshot"
  ADD COLUMN "isShort" BOOLEAN NOT NULL DEFAULT false;
