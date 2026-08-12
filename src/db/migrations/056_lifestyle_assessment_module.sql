-- ============================================================
-- 056_lifestyle_assessment_module.sql
-- New Lifestyle Assessment module: sleep, stress, hydration,
-- occupation/activity, workout experience, food preference, meal
-- frequency, smoking/alcohol, and a handful of additional lifestyle
-- factors, plus a deterministic Smart Lifestyle Analysis (scores,
-- risk classification, habit-risk badges) computed server-side.
--
-- Unlike pt_assessments/strength_logs/pt_goals, this is a brand new
-- table — client_id references pt_clients(id) correctly from the
-- start, no legacy-`clients`-table FK bug to fix later.
-- ============================================================

CREATE TABLE IF NOT EXISTS pt_lifestyle_assessments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  assessment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  assessment_number SMALLINT,

  -- Step 1: Sleep
  sleep_duration_hours NUMERIC(3,1),
  bed_time             TIME,
  wake_time            TIME,
  sleep_quality        SMALLINT,
  sleep_category       TEXT,
  sleep_score          SMALLINT,

  -- Step 2: Stress
  stress_level SMALLINT,
  stress_score SMALLINT,

  -- Step 3: Water
  water_intake_liters NUMERIC(3,1),
  hydration_category  TEXT,
  hydration_score     SMALLINT,

  -- Step 4: Occupation & Activity
  occupation_type     TEXT,
  daily_steps_bracket TEXT,
  activity_level      TEXT,
  activity_score      SMALLINT,

  -- Step 5: Workout Experience
  workout_experience_level TEXT,
  years_of_experience      NUMERIC(4,1),

  -- Step 6: Food Preference
  food_preferences TEXT[],

  -- Step 7: Meal Frequency
  meal_frequency    SMALLINT,
  breakfast_habit   TEXT,
  late_night_eating BOOLEAN,
  nutrition_score   SMALLINT,

  -- Step 8: Smoking & Alcohol
  smoking_status     TEXT,
  cigarettes_per_day SMALLINT,
  years_smoking      NUMERIC(4,1),
  alcohol_status     TEXT,
  drinks_per_week    SMALLINT,

  -- Step 9: Additional Lifestyle Factors
  screen_time_bracket    TEXT,
  travel_frequency       TEXT,
  energy_level           SMALLINT,
  motivation_to_exercise SMALLINT,
  recovery_quality       TEXT,
  recovery_score         SMALLINT,

  -- Smart Lifestyle Analysis (computed server-side)
  sedentary_risk      TEXT,
  recovery_risk       TEXT,
  habit_risk_score    SMALLINT,
  risk_factors        TEXT[],
  lifestyle_score     SMALLINT,
  lifestyle_readiness TEXT,

  -- Coach Notes ({recovery, nutrition, lifestyle, stress, sleep, special_instructions})
  coach_notes JSONB,

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pt_lifestyle_assessments_occupation_type_check
    CHECK (occupation_type IS NULL OR occupation_type IN (
      'desk_job','active_job','physical_labor','student','homemaker',
      'driver','healthcare','police','fitness_professional','retired','other'
    )),
  CONSTRAINT pt_lifestyle_assessments_daily_steps_bracket_check
    CHECK (daily_steps_bracket IS NULL OR daily_steps_bracket IN (
      '<3000','3000_5000','5000_8000','8000_10000','10000_plus'
    )),
  CONSTRAINT pt_lifestyle_assessments_workout_experience_level_check
    CHECK (workout_experience_level IS NULL OR workout_experience_level IN (
      'beginner','intermediate','advanced','athlete'
    )),
  CONSTRAINT pt_lifestyle_assessments_breakfast_habit_check
    CHECK (breakfast_habit IS NULL OR breakfast_habit IN ('daily','sometimes','never')),
  CONSTRAINT pt_lifestyle_assessments_smoking_status_check
    CHECK (smoking_status IS NULL OR smoking_status IN ('never','occasionally','daily','former')),
  CONSTRAINT pt_lifestyle_assessments_alcohol_status_check
    CHECK (alcohol_status IS NULL OR alcohol_status IN ('never','occasionally','weekly','frequently')),
  CONSTRAINT pt_lifestyle_assessments_screen_time_bracket_check
    CHECK (screen_time_bracket IS NULL OR screen_time_bracket IN ('<2','2_4','4_6','6_8','8_plus')),
  CONSTRAINT pt_lifestyle_assessments_travel_frequency_check
    CHECK (travel_frequency IS NULL OR travel_frequency IN ('rarely','monthly','weekly','daily')),
  CONSTRAINT pt_lifestyle_assessments_recovery_quality_check
    CHECK (recovery_quality IS NULL OR recovery_quality IN ('poor','average','good','excellent'))
);

CREATE INDEX IF NOT EXISTS pla_client_date_idx ON pt_lifestyle_assessments (client_id, assessment_date DESC);
