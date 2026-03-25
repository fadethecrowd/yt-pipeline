-- CreateTable
CREATE TABLE "wc_topic" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "summary" TEXT,
    "score" DOUBLE PRECISION,
    "status" "TopicStatus" NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wc_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wc_video" (
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

    CONSTRAINT "wc_video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wc_topic_url_key" ON "wc_topic"("url");

-- CreateIndex
CREATE INDEX "wc_topic_status_idx" ON "wc_topic"("status");

-- CreateIndex
CREATE INDEX "wc_topic_source_idx" ON "wc_topic"("source");

-- CreateIndex
CREATE INDEX "wc_topic_createdAt_idx" ON "wc_topic"("createdAt");

-- CreateIndex
CREATE INDEX "wc_video_status_idx" ON "wc_video"("status");

-- CreateIndex
CREATE INDEX "wc_video_topicId_idx" ON "wc_video"("topicId");

-- CreateIndex
CREATE INDEX "wc_video_createdAt_idx" ON "wc_video"("createdAt");

-- AddForeignKey
ALTER TABLE "wc_video" ADD CONSTRAINT "wc_video_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "wc_topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
