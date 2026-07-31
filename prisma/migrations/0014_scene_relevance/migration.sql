-- Additive only: per-scene semantic relevance result.
-- Adds nullable columns to scene_record; nothing else is touched.

-- AlterTable
ALTER TABLE "scene_record" ADD COLUMN     "assetDescription" TEXT,
ADD COLUMN     "relevanceReasons" TEXT[],
ADD COLUMN     "relevanceScore" DOUBLE PRECISION,
ADD COLUMN     "relevanceVerdict" TEXT;
