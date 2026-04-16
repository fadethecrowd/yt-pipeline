-- Mirrors 0006 onto WcVideo (wc_video) so PipelineContext.video can accept
-- both Video and WcVideo. Both fields stay NULL on Wet Circuit rows in
-- practice — thumbnailHeadlineGenerator is AI-Doom-only.

ALTER TABLE "wc_video"
  ADD COLUMN IF NOT EXISTS "thumbnailHeadline" TEXT,
  ADD COLUMN IF NOT EXISTS "thumbnailSubtext"  TEXT;
