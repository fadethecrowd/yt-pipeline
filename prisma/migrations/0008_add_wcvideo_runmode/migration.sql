-- Add runMode column to wc_video. Existing rows default to 'LIVE'
-- (the halt guard only blocks LIVE failures, not DRY_RUN failures).

ALTER TABLE "wc_video"
  ADD COLUMN IF NOT EXISTS "runMode" TEXT NOT NULL DEFAULT 'LIVE';
