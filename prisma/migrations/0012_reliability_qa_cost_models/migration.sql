-- Additive only: new reliability / QA / cost-control tables.
-- No existing table, column, index, or type is modified or dropped.

-- CreateEnum
CREATE TYPE "TestStage" AS ENUM ('DIAGNOSTIC', 'QUALIFICATION', 'RETEST', 'REPEATABILITY', 'PRODUCTION');

-- CreateTable
CREATE TABLE "elevenlabs_usage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "testStage" "TestStage" NOT NULL DEFAULT 'PRODUCTION',
    "runId" TEXT,
    "videoId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "generationId" TEXT,
    "requestId" TEXT,
    "model" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "outputFormat" TEXT NOT NULL,
    "requestedChars" INTEGER NOT NULL,
    "chargedChars" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retryReason" TEXT,
    "outputPath" TEXT,
    "audioDurationS" DOUBLE PRECISION,
    "success" BOOLEAN NOT NULL,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elevenlabs_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_record" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sceneNumber" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "startTimeS" DOUBLE PRECISION NOT NULL,
    "endTimeS" DOUBLE PRECISION NOT NULL,
    "prompt" TEXT NOT NULL,
    "assetSource" TEXT NOT NULL,
    "assetId" TEXT,
    "assetUrl" TEXT,
    "localPath" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationS" DOUBLE PRECISION,
    "cropMethod" TEXT,
    "validation" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "renderStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_record" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "testStage" "TestStage" NOT NULL,
    "videoId" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "youtubeId" TEXT,
    "runtimeS" DOUBLE PRECISION,
    "audioDurationS" DOUBLE PRECISION,
    "videoDurationS" DOUBLE PRECISION,
    "captionStartS" DOUBLE PRECISION,
    "captionEndS" DOUBLE PRECISION,
    "captionOffsetHead" DOUBLE PRECISION,
    "captionOffsetMid" DOUBLE PRECISION,
    "captionOffsetTail" DOUBLE PRECISION,
    "maxCaptionOffset" DOUBLE PRECISION,
    "scriptHash" TEXT,
    "creditsCharged" INTEGER,
    "generationIds" TEXT[],
    "privacyStatus" TEXT,
    "verifiedChannelId" TEXT,
    "audioResult" TEXT,
    "captionResult" TEXT,
    "visualResult" TEXT,
    "metadataResult" TEXT,
    "uploadResult" TEXT,
    "overall" TEXT NOT NULL,
    "failureNotes" TEXT,
    "requiredRepair" TEXT,
    "retestOf" TEXT,
    "reviewer" TEXT,
    "checks" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_budget" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "testStage" "TestStage" NOT NULL,
    "limitChars" INTEGER NOT NULL,
    "reservedChars" INTEGER NOT NULL DEFAULT 0,
    "chargedChars" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circuit_breaker" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "tripped" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT,
    "detail" TEXT,
    "affectedJobs" TEXT[],
    "trippedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circuit_breaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circuit_breaker_event" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "detail" TEXT,
    "videoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circuit_breaker_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "elevenlabs_usage_channel_createdAt_idx" ON "elevenlabs_usage"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "elevenlabs_usage_videoId_segmentIndex_idx" ON "elevenlabs_usage"("videoId", "segmentIndex");

-- CreateIndex
CREATE INDEX "elevenlabs_usage_videoId_segmentIndex_scriptHash_success_idx" ON "elevenlabs_usage"("videoId", "segmentIndex", "scriptHash", "success");

-- CreateIndex
CREATE INDEX "elevenlabs_usage_testStage_channel_idx" ON "elevenlabs_usage"("testStage", "channel");

-- CreateIndex
CREATE INDEX "scene_record_channel_createdAt_idx" ON "scene_record"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "scene_record_validation_idx" ON "scene_record"("validation");

-- CreateIndex
CREATE UNIQUE INDEX "scene_record_videoId_sceneNumber_key" ON "scene_record"("videoId", "sceneNumber");

-- CreateIndex
CREATE INDEX "qa_record_channel_createdAt_idx" ON "qa_record"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "qa_record_overall_idx" ON "qa_record"("overall");

-- CreateIndex
CREATE INDEX "qa_record_videoId_idx" ON "qa_record"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_budget_channel_testStage_key" ON "credit_budget"("channel", "testStage");

-- CreateIndex
CREATE UNIQUE INDEX "circuit_breaker_channel_key" ON "circuit_breaker"("channel");

-- CreateIndex
CREATE INDEX "circuit_breaker_event_channel_createdAt_idx" ON "circuit_breaker_event"("channel", "createdAt");
