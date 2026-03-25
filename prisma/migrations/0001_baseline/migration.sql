-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('DISCOVERED', 'APPROVED', 'SCRIPTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('SCRIPT_PENDING', 'SCRIPT_DONE', 'QUALITY_FAILED', 'VOICEOVER_PENDING', 'VOICEOVER_DONE', 'ASSEMBLY_PENDING', 'ASSEMBLY_DONE', 'SEO_PENDING', 'SEO_DONE', 'UPLOAD_PENDING', 'UPLOADED', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "summary" TEXT,
    "score" DOUBLE PRECISION,
    "status" "TopicStatus" NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "status" "VideoStatus" NOT NULL DEFAULT 'SCRIPT_PENDING',
    "scriptJson" JSONB,
    "qualityScore" INTEGER,
    "voiceoverUrls" TEXT[],
    "voiceoverPath" TEXT,
    "videoPath" TEXT,
    "videoUrl" TEXT,
    "thumbnailA" TEXT,
    "thumbnailB" TEXT,
    "thumbnailC" TEXT,
    "seoTitle" TEXT,
    "titleVariantB" TEXT,
    "titleVariantC" TEXT,
    "seoDescription" TEXT,
    "seoTags" TEXT[],
    "seoChapters" JSONB,
    "youtubeId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Topic_url_key" ON "Topic"("url");

-- CreateIndex
CREATE INDEX "Topic_status_idx" ON "Topic"("status");

-- CreateIndex
CREATE INDEX "Topic_source_idx" ON "Topic"("source");

-- CreateIndex
CREATE INDEX "Topic_createdAt_idx" ON "Topic"("createdAt");

-- CreateIndex
CREATE INDEX "Video_status_idx" ON "Video"("status");

-- CreateIndex
CREATE INDEX "Video_topicId_idx" ON "Video"("topicId");

-- CreateIndex
CREATE INDEX "Video_createdAt_idx" ON "Video"("createdAt");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
