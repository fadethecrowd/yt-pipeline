-- Pipeline run summary: one row per runPipeline() invocation in
-- yt-pipeline / wc-pipeline. Read-only from monitor for /status.

CREATE TYPE "PipelineRunStatus" AS ENUM ('CRITICAL', 'FAILED', 'WARNING', 'SUCCESS', 'IDLE');

CREATE TABLE "pipeline_run" (
    "id"                   TEXT NOT NULL,
    "channel"              TEXT NOT NULL,
    "runMode"              TEXT NOT NULL,
    "status"               "PipelineRunStatus" NOT NULL,
    "startTime"            TIMESTAMP(3) NOT NULL,
    "endTime"              TIMESTAMP(3),
    "durationMs"           INTEGER,
    "failedStage"          TEXT,
    "errorMessage"         TEXT,
    "warnings"             JSONB NOT NULL DEFAULT '[]'::jsonb,
    "videoId"              TEXT,
    "youtubeId"            TEXT,
    "scheduledAt"          TIMESTAMP(3),
    "shortsUrl"            TEXT,
    "verifiedChannelTitle" TEXT,
    "verifiedChannelId"    TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pipeline_run_channel_createdAt_idx"
  ON "pipeline_run" ("channel", "createdAt");
