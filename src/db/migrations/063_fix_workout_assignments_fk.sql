-- ============================================================
-- 063_fix_workout_assignments_fk.sql
-- Fix workout_assignments.client_id FK — still pointed at the dead
-- legacy `clients` table (0 rows) instead of `pt_clients` (the real,
-- actively-used table, 3 rows), missed when pt_assessments/strength_logs
-- (054) and progress_photos (058) were repointed. Same class of bug,
-- same fix pattern.
--
-- workout_assignments itself has 0 rows in production (verified via
-- live Supabase query before writing this migration), so this is a
-- no-data-loss repoint — no backfill/migration of existing rows needed.
--
-- Constraint name confirmed via information_schema.table_constraints
-- against the live DB (not guessed): workout_assignments_client_id_fkey,
-- which matches the default Postgres naming for the inline REFERENCES
-- clause in migration 006_premium_features.sql.
-- ============================================================

ALTER TABLE workout_assignments DROP CONSTRAINT IF EXISTS workout_assignments_client_id_fkey;
ALTER TABLE workout_assignments ADD CONSTRAINT workout_assignments_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;
