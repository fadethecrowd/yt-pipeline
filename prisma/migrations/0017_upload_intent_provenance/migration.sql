-- Additive only: evidence provenance for upload intents.
--
-- uVQ-vcJHWNk is the ai1 HBM qualification asset. Its YouTube identity is
-- verifiable, but it predates the correlation-marker mechanism and no surviving
-- record binds it to specific uploaded bytes: the immutable-approval mechanism
-- (commit b9d158c, 2026-07-31T19:54:45Z) landed AFTER the upload at
-- 2026-07-31T19:21:07Z. Recording it as a normal PERSISTED intent would claim
-- marker-backed, hash-verified provenance that does not exist.
--
-- Nothing here weakens the requirement that a real upload presents an exact,
-- verified file SHA-256 and scene-manifest hash: the NOT NULL is replaced by a
-- CHECK that still demands both for every state except the historical one.

-- Defaults describe a normal marker-backed upload, so existing behaviour and
-- every future row are unaffected.
ALTER TABLE "upload_intent"
  ADD COLUMN "provenance"             TEXT    NOT NULL DEFAULT 'MARKER_BACKED',
  ADD COLUMN "remoteMarkerPresent"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "fileHashVerified"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "manifestHashVerified"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "inferredFileSha256"     TEXT,
  ADD COLUMN "inferredManifestSha256" TEXT,
  ADD COLUMN "evidenceNote"           TEXT;

-- Allow the historical row to decline hashes it cannot prove.
ALTER TABLE "upload_intent" ALTER COLUMN "fileSha256"     DROP NOT NULL;
ALTER TABLE "upload_intent" ALTER COLUMN "manifestSha256" DROP NOT NULL;

-- Re-impose the exact-hash requirement for everything that is not a historical
-- reconciliation. A live upload still cannot exist without both hashes.
ALTER TABLE "upload_intent"
  ADD CONSTRAINT "upload_intent_hashes_required_unless_historical"
  CHECK (
    "state" = 'RECONCILED_HISTORICAL_UPLOAD'
    OR ("fileSha256" IS NOT NULL AND "manifestSha256" IS NOT NULL)
  );

-- A historical adoption must not claim a remote marker or verified hashes.
ALTER TABLE "upload_intent"
  ADD CONSTRAINT "upload_intent_historical_claims_no_verification"
  CHECK (
    "state" <> 'RECONCILED_HISTORICAL_UPLOAD'
    OR ("remoteMarkerPresent" = false
        AND "fileHashVerified" = false
        AND "manifestHashVerified" = false
        AND "provenance" <> 'MARKER_BACKED')
  );

-- At most one historical adoption per asset. Added alongside — rather than
-- replacing — the PERSISTED partial index, so no index is dropped.
CREATE UNIQUE INDEX "upload_intent_one_historical_per_video"
  ON "upload_intent"("videoId")
  WHERE "state" = 'RECONCILED_HISTORICAL_UPLOAD';
