-- 107_fitness_test_battery_second_slot.sql
--
-- Muscular Strength and Flexibility become 2-test batteries, the same
-- pattern Muscular Endurance already used (endurance_test_type /
-- endurance_test_type_2 / endurance_category / endurance_category_2 /
-- endurance_test_data). The product change: a trainer can run any of the
-- available tests in either module, but only 2 are required to complete
-- the section — mirroring how Endurance already requires exactly two
-- distinct tests.
--
-- Strength previously persisted only the FINAL computed score
-- (strength_score_computed) — no column stored which exercise was tested,
-- or the raw weight/reps/1RM that produced it. That's a pre-existing gap
-- (not something this migration is asked to fix for "test 1"), but a
-- second test needs *some* place to live, and reusing the same shape
-- endurance already proved out is the least risky path: a JSONB blob for
-- the raw per-test inputs, plus scalar "type" and "category" columns for
-- each of the two tests so the PDF report and any future dashboard can
-- show "Test 1: Squat — Excellent / Test 2: Bench Press — Good" without
-- re-deriving it from the JSONB every time.
--
-- Flexibility already had a JSONB blob (flexibility_test_data) and a
-- single flexibility_category. The blob's shape changes going forward to
-- {test1: {...}, test2: {...}} (no migration needed for a JSONB column to
-- hold a new shape); this migration only adds the missing
-- flexibility_category_2 scalar to match.
--
-- Purely additive — no column is dropped or renamed, so every existing
-- assessment row keeps reading back exactly as it did before.
--
-- Idempotent: safe to re-run.

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_exercise    TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_exercise_2  TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_category    TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_category_2  TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_test_data   JSONB;

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS flexibility_category_2 TEXT;

COMMENT ON COLUMN pt_assessments.strength_test_data IS
  'Raw per-test inputs: {test1: {exercise, weightKg, reps, formula, direct1RM, isDirect}, test2: {...}}. Mirrors endurance_test_data.';
COMMENT ON COLUMN pt_assessments.flexibility_test_data IS
  'Raw per-test inputs, {test1: {...}, test2: {...}} going forward. Older rows may still hold the pre-battery flat shape ({testType, left, right, ...}); readers should handle both.';
