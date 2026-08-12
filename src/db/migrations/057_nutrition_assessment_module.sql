-- ============================================================
-- 057_nutrition_assessment_module.sql
-- New Nutrition Assessment module: diet preference, allergies/foods
-- to avoid, favourite foods, supplement usage (with per-item dose/
-- frequency/brand), digestive health (with per-issue frequency/
-- severity), meal pattern & eating behaviour, hydration & cravings,
-- and cooking/budget/medical context, plus a deterministic Smart
-- Nutrition Analysis computed server-side.
--
-- New table — client_id references pt_clients(id) correctly from
-- the start, no legacy-`clients`-table FK bug to fix later.
-- ============================================================

CREATE TABLE IF NOT EXISTS pt_nutrition_assessments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  assessment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  assessment_number SMALLINT,

  -- Step 1: Diet Preference
  diet_preferences TEXT[],

  -- Step 2: Food Restrictions
  food_allergies        TEXT[],
  foods_to_avoid        TEXT[],
  foods_to_avoid_reason TEXT,

  -- Step 3: Favourite Foods
  favourite_foods TEXT[],

  -- Step 4: Supplements
  takes_supplements BOOLEAN,
  supplements       JSONB,

  -- Step 5: Digestive Health
  digestive_issues JSONB,

  -- Step 6: Meal Pattern & Eating Behaviour
  meals_per_day            SMALLINT,
  breakfast_regularity     TEXT,
  lunch_regularity         TEXT,
  dinner_regularity        TEXT,
  snacks_per_day           SMALLINT,
  late_night_eating        BOOLEAN,
  meal_timing_consistency  TEXT,
  eating_out_frequency     TEXT,
  weekend_eating_habits    TEXT,
  eating_behaviours        TEXT[],

  -- Step 7: Hydration & Cravings
  water_intake_liters       NUMERIC(3,1),
  tea_cups_per_day          SMALLINT,
  coffee_cups_per_day       SMALLINT,
  soft_drinks_per_day       SMALLINT,
  juices_per_day            SMALLINT,
  alcoholic_drinks_per_week SMALLINT,
  daily_fluid_intake_liters NUMERIC(3,1),
  cravings                  TEXT[],
  craving_frequency         TEXT,

  -- Step 8: Context
  meal_preparer      TEXT,
  nutrition_budget    TEXT,
  medical_conditions  TEXT[],
  medical_notes       TEXT,

  -- Smart Nutrition Analysis (computed server-side)
  diet_quality_score      SMALLINT,
  protein_score           SMALLINT,
  protein_assessment      TEXT,
  hydration_score         SMALLINT,
  digestive_health_score  SMALLINT,
  supplement_score        SMALLINT,
  nutrition_risk_score    SMALLINT,
  risk_factors            TEXT[],
  nutrition_score         SMALLINT,
  nutrition_readiness     TEXT,

  -- Coach Notes ({dietary_advice, meal_planning, supplement_advice, medical_notes, special_instructions})
  coach_notes JSONB,

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pt_nutrition_assessments_avoid_reason_check
    CHECK (foods_to_avoid_reason IS NULL OR foods_to_avoid_reason IN ('medical','religious','personal_preference','taste','digestive_issue')),
  CONSTRAINT pt_nutrition_assessments_breakfast_regularity_check
    CHECK (breakfast_regularity IS NULL OR breakfast_regularity IN ('daily','sometimes','never')),
  CONSTRAINT pt_nutrition_assessments_lunch_regularity_check
    CHECK (lunch_regularity IS NULL OR lunch_regularity IN ('daily','sometimes','never')),
  CONSTRAINT pt_nutrition_assessments_dinner_regularity_check
    CHECK (dinner_regularity IS NULL OR dinner_regularity IN ('daily','sometimes','never')),
  CONSTRAINT pt_nutrition_assessments_timing_consistency_check
    CHECK (meal_timing_consistency IS NULL OR meal_timing_consistency IN ('consistent','somewhat_consistent','inconsistent')),
  CONSTRAINT pt_nutrition_assessments_eating_out_check
    CHECK (eating_out_frequency IS NULL OR eating_out_frequency IN ('rarely','weekly','frequently','daily')),
  CONSTRAINT pt_nutrition_assessments_weekend_habits_check
    CHECK (weekend_eating_habits IS NULL OR weekend_eating_habits IN ('similar_to_weekday','somewhat_different','very_different_indulgent')),
  CONSTRAINT pt_nutrition_assessments_craving_frequency_check
    CHECK (craving_frequency IS NULL OR craving_frequency IN ('rare','sometimes','daily')),
  CONSTRAINT pt_nutrition_assessments_meal_preparer_check
    CHECK (meal_preparer IS NULL OR meal_preparer IN ('self','family','cook','restaurant','food_delivery','mess','hostel','office_cafeteria')),
  CONSTRAINT pt_nutrition_assessments_budget_check
    CHECK (nutrition_budget IS NULL OR nutrition_budget IN ('low','medium','high','premium'))
);

CREATE INDEX IF NOT EXISTS pna_client_date_idx ON pt_nutrition_assessments (client_id, assessment_date DESC);
