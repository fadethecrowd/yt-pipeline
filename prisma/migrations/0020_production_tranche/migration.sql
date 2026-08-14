-- Finite, expiring authorization for ordinary production spend.
--
-- HAND-WRITTEN and purely additive, for the same reason 0019 was: generating
-- from the superset schema also emits pre-existing drift (a topic_library index
-- and several ALTER COLUMN ... DROP DEFAULT on monitor tables) that has nothing
-- to do with this feature. Only the new objects are kept here. Nothing existing
-- is modified, renamed, truncated or dropped.

-- CreateEnum
CREATE TYPE "ProductionTrancheStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TrancheSlotStatus" AS ENUM ('CLAIMED', 'SETTLED_SUCCESS', 'SETTLED_FAILED', 'RECONCILIATION_REQUIRED');

-- CreateTable
CREATE TABLE "production_tranche" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "maxCandidates" INTEGER NOT NULL,
    "consumedCandidates" INTEGER NOT NULL DEFAULT 0,
    "status" "ProductionTrancheStatus" NOT NULL DEFAULT 'ACTIVE',
    "shortsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "authorizedBy" TEXT NOT NULL,
    "policyCommit" TEXT,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_tranche_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_tranche_slot" (
    "id" TEXT NOT NULL,
    "trancheId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "status" "TrancheSlotStatus" NOT NULL DEFAULT 'CLAIMED',
    "videoId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_tranche_slot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_tranche_channel_status_idx" ON "production_tranche"("channel", "status");
CREATE INDEX "production_tranche_status_expiresAt_idx" ON "production_tranche"("status", "expiresAt");
CREATE UNIQUE INDEX "production_tranche_slot_trancheId_slotIndex_key" ON "production_tranche_slot"("trancheId", "slotIndex");
CREATE UNIQUE INDEX "production_tranche_slot_videoId_key" ON "production_tranche_slot"("videoId");
CREATE INDEX "production_tranche_slot_channel_status_idx" ON "production_tranche_slot"("channel", "status");

-- AddForeignKey
ALTER TABLE "production_tranche_slot" ADD CONSTRAINT "production_tranche_slot_trancheId_fkey" FOREIGN KEY ("trancheId") REFERENCES "production_tranche"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
