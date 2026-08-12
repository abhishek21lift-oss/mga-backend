-- ============================================================
-- 069_exercises_columns_backfill.sql
-- The live `exercises` table already carries body_part, target_muscle,
-- secondary_muscles, equipment, instructions, gif_url, exercise_type,
-- force, mechanic, source_id (added out-of-band during the free-exercise-db
-- import, never captured in a tracked migration — src/routes/workouts.js
-- and scripts/import-exercises.js have relied on them ever since). This
-- migration is a no-op on the live DB but brings the tracked schema back
-- in sync with reality using IF NOT EXISTS, so a fresh environment ends
-- up with the same columns.
-- ============================================================

ALTER TABLE exercises ADD COLUMN IF NOT EXISTS body_part TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS target_muscle TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS secondary_muscles TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS equipment TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS gif_url TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS exercise_type TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS force TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS mechanic TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS source_id TEXT;

CREATE INDEX IF NOT EXISTS exercises_body_part_idx ON exercises (body_part);
