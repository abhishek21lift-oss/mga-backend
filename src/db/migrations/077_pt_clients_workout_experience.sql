-- 077_pt_clients_workout_experience.sql
-- Adds a "Workout Experience" field to PT Enrollment, captured at
-- enrollment time rather than only later via a Lifestyle Assessment.
-- Same value set and CHECK constraint as
-- pt_lifestyle_assessments.workout_experience_level for consistency.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS workout_experience_level TEXT;

ALTER TABLE pt_clients DROP CONSTRAINT IF EXISTS pt_clients_workout_experience_level_check;
ALTER TABLE pt_clients ADD CONSTRAINT pt_clients_workout_experience_level_check
  CHECK (workout_experience_level IS NULL OR workout_experience_level = ANY (ARRAY['beginner','intermediate','advanced','athlete']));
