-- ============================================================
-- 044_trainers_metadata.sql
-- Adds metadata JSONB column plus bio and schedule TEXT columns
-- to the trainers table. These hold the ~25 extended profile
-- fields that the Add/Edit Coach forms collect but that have
-- no dedicated column in the original schema.
-- ============================================================

ALTER TABLE trainers ADD COLUMN IF NOT EXISTS bio      TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS schedule TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
