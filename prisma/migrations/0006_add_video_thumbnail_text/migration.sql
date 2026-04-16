-- Adds thumbnail-specific text fields to Video for AI Doom pipeline.
-- Both columns are nullable; existing rows backfill to NULL.
-- thumbnailGenerator falls back to seoTitle/topicTitle if NULL, so this is
-- non-breaking for any in-flight or historical row.

ALTER TABLE "Video"
  ADD COLUMN IF NOT EXISTS "thumbnailHeadline" TEXT,
  ADD COLUMN IF NOT EXISTS "thumbnailSubtext"  TEXT;
