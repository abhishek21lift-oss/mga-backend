-- ============================================================
-- 054_fitness_testing_module.sql
-- Adds the 7-step scientific assessment fields + computed 0-100
-- category scores to pt_assessments, and links strength_logs rows
-- back to the assessment they were recorded under.
--
-- Legacy 1-10 flexibility_score/cardio_score/strength_score columns
-- are left untouched — new computed scores use distinct
-- *_computed / *_score column names on purpose (different 0-100
-- scale, no other code reads the legacy columns outside the two
-- pages this module supersedes).
--
-- Also repoints pt_assessments.client_id and strength_logs.client_id
-- from the dead/empty legacy `clients` table to `pt_clients` — this
-- FK was blocking every assessment/strength-log insert for any real
-- (pt_clients-based) client, discovered while building this feature.
-- NOTE: ~26 other tables still reference the empty `clients` table
-- (goals, weight_logs, workouts, weekly_checkins, progress_photos,
-- etc.) — that is a separate, wider pre-existing bug, deliberately
-- NOT addressed here; only the two tables this migration already
-- touches are repointed.
-- ============================================================

ALTER TABLE pt_assessments DROP CONSTRAINT IF EXISTS pt_assessments_client_id_fkey;
ALTER TABLE pt_assessments ADD CONSTRAINT pt_assessments_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

ALTER TABLE strength_logs DROP CONSTRAINT IF EXISTS strength_logs_client_id_fkey;
ALTER TABLE strength_logs ADD CONSTRAINT strength_logs_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

-- Widen assessment_type to support the new step-based labels while
-- keeping old values valid for historical rows.
ALTER TABLE pt_assessments DROP CONSTRAINT IF EXISTS pt_assessments_assessment_type_check;
ALTER TABLE pt_assessments ADD CONSTRAINT pt_assessments_assessment_type_check
  CHECK (assessment_type IN ('initial','week_4','week_8','week_12','monthly','quarterly','follow_up','custom'));

-- Sequencing / metadata
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS assessment_number      SMALLINT;

-- Step 1 — Blood Pressure
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bp_systolic            SMALLINT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bp_diastolic           SMALLINT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS resting_heart_rate     SMALLINT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS resting_spo2           NUMERIC(4,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bp_category            TEXT;

-- Step 2 — Anthropometric (weight/height_cm/bmi/waist_cm/hips_cm/chest_cm
-- already exist; arms_cm/thighs_cm kept as legacy single-value columns
-- for old rows, unused by the new module which writes right/left pairs)
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS waist_hip_ratio        NUMERIC(4,2);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS neck_cm                NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS arm_right_cm           NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS arm_left_cm            NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS thigh_right_cm         NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS thigh_left_cm          NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS calf_right_cm          NUMERIC(5,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS calf_left_cm           NUMERIC(5,1);

-- Step 3 — Body Composition (body_fat_pct/muscle_mass_pct already exist)
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS body_comp_method       TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS lean_body_mass_kg      NUMERIC(5,2);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS fat_mass_kg            NUMERIC(5,2);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS visceral_fat           NUMERIC(4,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS subcutaneous_fat_pct   NUMERIC(4,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS body_water_pct         NUMERIC(4,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bone_mass_kg           NUMERIC(4,1);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bmr                    INT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS bmr_auto_suggested     BOOLEAN DEFAULT FALSE;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS metabolic_age          SMALLINT;

-- Step 4 — Cardiorespiratory Endurance
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS cardio_test_type       TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS cardio_test_data       JSONB;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS vo2_max                NUMERIC(5,2);
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS cardio_category        TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS cardio_score_computed  SMALLINT;

-- Step 5 — Muscular Strength (row data lives in strength_logs; this is
-- just the rolled-up 0-100 score for the radar/dashboard)
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS strength_score_computed SMALLINT;

-- Step 6 — Muscular Endurance
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS endurance_test_data      JSONB;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS endurance_category       TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS endurance_score_computed SMALLINT;

-- Step 7 — Flexibility / Mobility
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS flexibility_test_data    JSONB;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS flexibility_category     TEXT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS has_asymmetry            BOOLEAN DEFAULT FALSE;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS mobility_score_computed  SMALLINT;

-- Overall dashboard
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS body_composition_score  SMALLINT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS health_risk_score       SMALLINT;
ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS overall_fitness_score   SMALLINT;

-- strength_logs: link rows back to the assessment they were taken under,
-- and record which 1RM method was used. Nullable — existing/ongoing
-- workout-log rows from the strength-tracking page keep assessment_id = NULL.
ALTER TABLE strength_logs ADD COLUMN IF NOT EXISTS assessment_id   TEXT REFERENCES pt_assessments(id) ON DELETE SET NULL;
ALTER TABLE strength_logs ADD COLUMN IF NOT EXISTS one_rm_formula  TEXT DEFAULT 'epley';
ALTER TABLE strength_logs ADD COLUMN IF NOT EXISTS is_direct_1rm   BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS sl_assessment_idx ON strength_logs (assessment_id);
