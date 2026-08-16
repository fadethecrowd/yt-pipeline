-- Give back a tranche attempt when the candidate failed deterministically
-- before any irreversible action.
--
-- HAND-WRITTEN and purely additive, for the same reason 0019 and 0020 were:
-- generating from the superset schema also emits pre-existing drift unrelated
-- to this feature. Only the new objects are here. Nothing existing is modified,
-- renamed, truncated or dropped.
--
-- consumedCandidates stays MONOTONIC so slotIndex remains unique; effective
-- consumption is consumedCandidates - releasedCandidates.

ALTER TYPE "TrancheSlotStatus" ADD VALUE IF NOT EXISTS 'RELEASED';

ALTER TABLE "production_tranche"
  ADD COLUMN IF NOT EXISTS "releasedCandidates" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "production_tranche_slot"
  ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "releaseReason" TEXT,
  ADD COLUMN IF NOT EXISTS "releaseClassification" TEXT;
