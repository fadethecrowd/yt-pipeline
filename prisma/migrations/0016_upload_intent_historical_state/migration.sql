-- Additive only: one new enum value.
--
-- Kept in its own migration because PostgreSQL will not allow a newly added
-- enum value to be REFERENCED in the same transaction that adds it
-- ("unsafe use of new value ... must be committed before they can be used").
-- Migration 0017 adds the CHECK constraints that use it.
--
-- RECONCILED_HISTORICAL_UPLOAD is terminal and upload-blocking like PERSISTED,
-- but is never produced by a live upload path: it marks a pre-existing remote
-- video adopted retrospectively, whose artifact binding is inferred rather than
-- cryptographically verified.

ALTER TYPE "UploadIntentState" ADD VALUE IF NOT EXISTS 'RECONCILED_HISTORICAL_UPLOAD';
