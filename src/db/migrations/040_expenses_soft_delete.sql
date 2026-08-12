-- ============================================================
-- 040_expenses_soft_delete.sql
-- ISSUE-030: Add deleted_at column to expenses table so that
-- DELETE operations can be converted to soft deletes.
-- Existing rows retain deleted_at = NULL (not deleted).
-- ============================================================

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS expenses_deleted_at_idx ON expenses (deleted_at)
  WHERE deleted_at IS NULL;
