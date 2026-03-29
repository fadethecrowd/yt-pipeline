-- AlterTable: add hookSegment and shortsUrl to wc_video
ALTER TABLE "wc_video" ADD COLUMN "hookSegment" TEXT;
ALTER TABLE "wc_video" ADD COLUMN "shortsUrl" TEXT;
