-- 008_fix_migration_numbers.sql
-- Clean up orphaned _migrations entries from renamed files.
-- The three renamed files are idempotent (IF NOT EXISTS / CREATE OR REPLACE),
-- so they will be safely re-applied under their new names on next startup.
-- On fresh databases this DELETE is a no-op.
DELETE FROM _migrations WHERE filename IN (
  '002_leave_upgrade.sql',
  '003_plans_table.sql',
  '004_face_checkin_logs.sql'
);
