-- Additive only: job quarantine + script-failure classification.
-- No existing table, column, index, or type is modified or dropped.

-- CreateEnum
CREATE TYPE "ScriptFailureType" AS ENUM ('VALID', 'MODEL_REFUSAL', 'OFF_TOPIC', 'THIN_SOURCE', 'TRUNCATED_JSON', 'MALFORMED_JSON', 'EMPTY_RESPONSE', 'SCHEMA_INVALID', 'API_ERROR');

-- CreateTable
CREATE TABLE "job_quarantine" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "originalStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "actionSource" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "script_generation_failure" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "videoId" TEXT,
    "topicId" TEXT,
    "topicTitle" TEXT,
    "pillar" TEXT,
    "failureType" "ScriptFailureType" NOT NULL,
    "detail" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "script_generation_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_quarantine_channel_createdAt_idx" ON "job_quarantine"("channel", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "job_quarantine_videoId_releasedAt_key" ON "job_quarantine"("videoId", "releasedAt");

-- CreateIndex
CREATE INDEX "script_generation_failure_channel_createdAt_idx" ON "script_generation_failure"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "script_generation_failure_failureType_idx" ON "script_generation_failure"("failureType");
