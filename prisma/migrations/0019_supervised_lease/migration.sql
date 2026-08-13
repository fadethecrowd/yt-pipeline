-- Durable supervised-run lease.
--
-- HAND-WRITTEN, not the raw `migrate diff` output. Generating from the
-- superset produced eight statements that have nothing to do with this table:
-- a DROP INDEX on topic_library (immediately recreated) and seven
-- `ALTER COLUMN "channel" DROP DEFAULT` on the monitor tables. Those are
-- pre-existing drift between the schema files and the live database, and
-- `npm run db:check-migrations` correctly refused the generated file. Applying
-- them would change existing monitor tables while adding an unrelated feature,
-- so only the additive statements are kept here.
--
-- Purely additive: one new table and two new indexes. Nothing existing is
-- modified, renamed, truncated or dropped.

-- CreateTable
CREATE TABLE "supervised_lease" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "pilotId" TEXT NOT NULL,
    "controllerToken" TEXT NOT NULL,
    "videoId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervised_lease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supervised_lease_channel_status_idx" ON "supervised_lease"("channel", "status");

-- CreateIndex
CREATE INDEX "supervised_lease_status_expiresAt_idx" ON "supervised_lease"("status", "expiresAt");
