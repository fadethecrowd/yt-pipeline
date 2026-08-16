-- Additive only: per-scene retrieval provenance.
-- Adds nullable columns to scene_record; nothing else is touched.
--
-- Diagnosing run e704334a was blind because neither the query that produced an
-- asset nor the candidates it beat were ever written down — only the winner.
-- Without these the next diagnosis is blind in exactly the same way.

-- AlterTable
ALTER TABLE "scene_record" ADD COLUMN     "retrievalQuery" TEXT,
ADD COLUMN     "subjectPrompt" TEXT,
ADD COLUMN     "runnerUps" JSONB;
