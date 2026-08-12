-- ============================================================
-- 053_pt_clients_enrollment_fields.sql
-- Adds program-scheduling columns to pt_clients for the redesigned
-- PT Enrollment section: training mode, preferred workout time,
-- preferred training days, and sessions per week.
-- Coach is represented by the existing trainer_id/trainer_name
-- columns — no separate coach_id column is needed.
-- ============================================================

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS training_mode           TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS preferred_workout_time  TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS preferred_training_days TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS sessions_per_week       SMALLINT;
