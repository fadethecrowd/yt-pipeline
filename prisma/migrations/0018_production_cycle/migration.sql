-- Additive only: durable authorization for one ordinary production cycle.
--
-- Neither channel has a recurring trigger, so ordinary production happens only
-- when a container starts. With the pipeline unlocked, ANY start — deploy,
-- restart, env change, infrastructure event — would reach discovery and create
-- a video, because nothing durable said whether a video was owed. This table is
-- that missing statement.
--
-- Identity is the intended PUBLICATION slot, not container start time, so a
-- restart at any hour resolves to the same cycle rather than a new one. The
-- unique constraint below is the entire guarantee: a duplicate scheduler event
-- becomes a no-op instead of a second video.
--
-- Creates one new type and one new table. No existing table, column, index or
-- row is altered, dropped or rewritten, so this is safe to apply against
-- current production data with no backfill.

CREATE TYPE "ProductionCycleStatus" AS ENUM (
  'AUTHORIZED',
  'CLAIMED',
  'COMPLETED',
  'FAILED',
  'RECONCILIATION_REQUIRED'
);

CREATE TABLE "production_cycle" (
  "id"                TEXT                     NOT NULL,
  "channel"           TEXT                     NOT NULL,
  -- UTC instant of the Eastern wall-clock slot (M/W/F 15:00 America/New_York).
  "targetPublishSlot" TIMESTAMP(3)             NOT NULL,
  "status"            "ProductionCycleStatus"  NOT NULL DEFAULT 'AUTHORIZED',

  -- Set by the single winning claimant.
  "claimantId"        TEXT,
  -- The one candidate this cycle may produce. AI Doom rows live in "Video" and
  -- Wet Circuit rows in "WcVideo", so this is a plain id validated in
  -- application code: no single foreign key could reference both tables, and a
  -- polymorphic FK would be a lie the database could not enforce.
  "videoId"           TEXT,
  "pipelineRunId"     TEXT,
  "failureCode"       TEXT,

  "authorizedAt"      TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt"         TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "failedAt"          TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)             NOT NULL,

  CONSTRAINT "production_cycle_pkey" PRIMARY KEY ("id")
);

-- One cycle per channel per publication slot. A duplicate authorization
-- attempt violates this and is handled as "already authorized", never as a
-- second cycle.
CREATE UNIQUE INDEX "production_cycle_channel_targetPublishSlot_key"
  ON "production_cycle" ("channel", "targetPublishSlot");

CREATE INDEX "production_cycle_channel_status_idx"
  ON "production_cycle" ("channel", "status");
