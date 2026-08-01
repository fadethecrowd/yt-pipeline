-- Additive only: durable upload intent.
--
-- Creates one new enum, one new table and its indexes. No existing table,
-- column, index, constraint or row is altered or dropped.
--
-- Why: `youtubeId IS NULL` was treated as proof that nothing had been
-- uploaded. It is not. Qualification asset ai1 was accepted by YouTube as
-- uVQ-vcJHWNk and the process died before the id was persisted, leaving a
-- remote video that every local check reported as "never uploaded". A retry
-- would have uploaded a second copy. The intent row is written BEFORE the
-- remote call, so that same crash now leaves an unresolved, reconcilable
-- record instead of silence.
--
-- NOTE: `prisma migrate diff` against the live database also reports
-- unrelated pre-existing drift (DROP DEFAULT on monitor `channel` columns and
-- a topic_library index reorder). That drift is deliberately NOT included
-- here: it predates this change and dropping defaults is not additive.

-- CreateEnum
CREATE TYPE "UploadIntentState" AS ENUM (
  'PREPARED',
  'UPLOAD_STARTED',
  'REMOTE_CONFIRMED',
  'PERSISTED',
  'RECONCILIATION_REQUIRED',
  'FAILED_BEFORE_REMOTE_CALL'
);

-- CreateTable
CREATE TABLE "upload_intent" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "testStage" "TestStage" NOT NULL,
    "format" TEXT NOT NULL,
    "assetKey" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL DEFAULT 'video',
    "fileSha256" TEXT NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "metadataFingerprint" TEXT NOT NULL,
    "expectedTitle" TEXT NOT NULL,
    "expectedPrivacy" TEXT NOT NULL DEFAULT 'private',
    "publishAtAbsent" BOOLEAN NOT NULL DEFAULT true,
    "expectedDurationS" DOUBLE PRECISION,
    "durationToleranceS" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "state" "UploadIntentState" NOT NULL DEFAULT 'PREPARED',
    "youtubeId" TEXT,
    "remoteEtag" TEXT,
    "remotePublishedAt" TIMESTAMP(3),
    "adopted" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "reconcileNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_intent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a correlation marker is never reused.
CREATE UNIQUE INDEX "upload_intent_correlationId_key" ON "upload_intent"("correlationId");

-- CreateIndex: one approved artifact never maps to two YouTube ids, and two
-- intents never adopt the same remote video.
CREATE UNIQUE INDEX "upload_intent_youtubeId_key" ON "upload_intent"("youtubeId");

-- CreateIndex
CREATE INDEX "upload_intent_state_idx" ON "upload_intent"("state");

-- CreateIndex
CREATE INDEX "upload_intent_channel_createdAt_idx" ON "upload_intent"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "upload_intent_videoId_idx" ON "upload_intent"("videoId");

-- CreateIndex: one intent per (asset, approved artifact). A retry reuses the
-- existing row instead of opening a second upload path.
CREATE UNIQUE INDEX "upload_intent_videoId_fileSha256_manifestSha256_key"
  ON "upload_intent"("videoId", "fileSha256", "manifestSha256");

-- CreateIndex: at most ONE completed upload per asset, across all artifacts.
-- Partial index, so superseded/abandoned intents for the same asset remain
-- legal while a second PERSISTED row is rejected by the database itself.
CREATE UNIQUE INDEX "upload_intent_one_persisted_per_video"
  ON "upload_intent"("videoId")
  WHERE "state" = 'PERSISTED';

-- CreateIndex: at most ONE in-flight intent per asset. PREPARED and
-- UPLOAD_STARTED both mean "an upload path is open"; a second concurrent
-- attempt is rejected rather than racing.
CREATE UNIQUE INDEX "upload_intent_one_active_per_video"
  ON "upload_intent"("videoId")
  WHERE "state" IN ('PREPARED', 'UPLOAD_STARTED');
