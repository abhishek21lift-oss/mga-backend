-- 006_premium_features.sql
-- New tables for premium enterprise pages.
-- Uses DO blocks so individual failures are logged but don't abort the migration.

-- ─── INVOICES ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS invoices (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    invoice_no      TEXT        UNIQUE NOT NULL,
    client_id       TEXT        REFERENCES clients(id) ON DELETE RESTRICT,
    client_name     TEXT,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    status          TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','paid','partial','overdue','cancelled')),
    due_date        DATE,
    issue_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    payment_method  TEXT,
    notes           TEXT,
    pdf_url         TEXT,
    sent_at         TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'invoices table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS invoices_client_idx ON invoices (client_id);
  CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);
  CREATE INDEX IF NOT EXISTS invoices_date_idx   ON invoices (issue_date DESC);
  CREATE INDEX IF NOT EXISTS invoices_due_idx    ON invoices (due_date);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'invoices indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS invoice_items (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    invoice_id      TEXT        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description     TEXT        NOT NULL,
    quantity        INT         NOT NULL DEFAULT 1,
    unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    type            TEXT        DEFAULT 'membership'
                    CHECK (type IN ('membership','pt','addon','diet','other')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'invoice_items table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS inv_items_inv_idx ON invoice_items (invoice_id);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'invoice_items index: %', SQLERRM; END $$;


-- ─── EXERCISES / WORKOUT PLANS ────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS exercises (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    description     TEXT,
    muscle_group    TEXT        NOT NULL
                    CHECK (muscle_group IN ('Chest','Back','Legs','Shoulders','Arms','Core','Cardio','Full Body')),
    difficulty      TEXT        DEFAULT 'beginner'
                    CHECK (difficulty IN ('beginner','intermediate','advanced')),
    sets_default    INT         DEFAULT 3,
    reps_default    INT         DEFAULT 12,
    rest_seconds    INT         DEFAULT 60,
    video_url       TEXT,
    image_url       TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'exercises table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS exercises_muscle_idx ON exercises (muscle_group);
  CREATE INDEX IF NOT EXISTS exercises_active_idx ON exercises (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'exercises indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS workout_plans (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    description     TEXT,
    goal            TEXT        CHECK (goal IN ('weight_loss','muscle_gain','endurance','general_fitness','recovery')),
    difficulty      TEXT        DEFAULT 'beginner'
                    CHECK (difficulty IN ('beginner','intermediate','advanced')),
    duration_weeks  INT         DEFAULT 4,
    sessions_per_week INT       DEFAULT 3,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    is_template     BOOLEAN     NOT NULL DEFAULT TRUE,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_plans table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS wp_goal_idx   ON workout_plans (goal);
  CREATE INDEX IF NOT EXISTS wp_active_idx ON workout_plans (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_plans indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS workout_exercises (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    workout_plan_id TEXT        NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    exercise_id     TEXT        NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    day_of_week     INT         NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    sort_order      INT         NOT NULL DEFAULT 0,
    sets            INT         NOT NULL DEFAULT 3,
    reps            INT         NOT NULL DEFAULT 12,
    rest_seconds    INT         DEFAULT 60,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_exercises table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS we_plan_idx ON workout_exercises (workout_plan_id);
  CREATE INDEX IF NOT EXISTS we_day_idx  ON workout_exercises (workout_plan_id, day_of_week);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_exercises indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS workout_assignments (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    workout_plan_id TEXT        NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
    start_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    end_date        DATE,
    status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','paused','cancelled')),
    progress_pct    INT         DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workout_plan_id, client_id, status)
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_assignments table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS wa_client_idx ON workout_assignments (client_id);
  CREATE INDEX IF NOT EXISTS wa_status_idx ON workout_assignments (status);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'workout_assignments indexes: %', SQLERRM; END $$;


-- ─── DIET / NUTRITION PLANS ───────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS meals (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    description     TEXT,
    meal_type       TEXT        NOT NULL
                    CHECK (meal_type IN ('breakfast','lunch','snacks','dinner','pre_workout','post_workout')),
    calories        INT         NOT NULL DEFAULT 0,
    protein_g       NUMERIC(6,1) DEFAULT 0,
    carbs_g         NUMERIC(6,1) DEFAULT 0,
    fats_g          NUMERIC(6,1) DEFAULT 0,
    serving_size    TEXT,
    image_url       TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'meals table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS meals_type_idx   ON meals (meal_type);
  CREATE INDEX IF NOT EXISTS meals_active_idx ON meals (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'meals indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS diet_templates (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    description     TEXT,
    goal            TEXT        CHECK (goal IN ('weight_loss','muscle_gain','maintenance','keto','vegan','custom')),
    daily_calories  INT         DEFAULT 2000,
    daily_protein_g NUMERIC(6,1) DEFAULT 0,
    daily_carbs_g   NUMERIC(6,1) DEFAULT 0,
    daily_fats_g    NUMERIC(6,1) DEFAULT 0,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_templates table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS dt_goal_idx   ON diet_templates (goal);
  CREATE INDEX IF NOT EXISTS dt_active_idx ON diet_templates (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_templates indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS diet_plan_meals (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    diet_template_id TEXT       NOT NULL REFERENCES diet_templates(id) ON DELETE CASCADE,
    meal_id         TEXT        NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    day_of_week     INT         CHECK (day_of_week BETWEEN 1 AND 7),
    sort_order      INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_plan_meals table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS dpm_template_idx ON diet_plan_meals (diet_template_id);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_plan_meals index: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS diet_assignments (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    diet_template_id TEXT       NOT NULL REFERENCES diet_templates(id) ON DELETE CASCADE,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
    start_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    end_date        DATE,
    status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','paused','cancelled')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (diet_template_id, client_id, status)
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_assignments table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS da_client_idx ON diet_assignments (client_id);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet_assignments index: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS nutrition_logs (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    log_date        DATE        NOT NULL DEFAULT CURRENT_DATE,
    calories_consumed INT       DEFAULT 0,
    protein_g       NUMERIC(6,1) DEFAULT 0,
    carbs_g         NUMERIC(6,1) DEFAULT 0,
    fats_g          NUMERIC(6,1) DEFAULT 0,
    water_glasses   INT         DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, log_date)
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'nutrition_logs table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS nl_client_idx ON nutrition_logs (client_id, log_date DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'nutrition_logs index: %', SQLERRM; END $$;


-- ─── CLIENT FITNESS PROFILE EXTENSIONS ────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS client_fitness_profiles (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
    goal            TEXT        CHECK (goal IN ('weight_loss','muscle_gain','endurance','general_fitness','recovery','other')),
    goal_other      TEXT,
    height_cm       NUMERIC(5,1),
    body_fat_pct    NUMERIC(4,1),
    health_conditions TEXT[],
    injuries        TEXT,
    emergency_contact  TEXT,
    emergency_phone    TEXT,
    fitness_level   TEXT        CHECK (fitness_level IN ('beginner','intermediate','advanced','athlete')),
    sleep_hours     NUMERIC(3,1),
    stress_level    TEXT        CHECK (stress_level IN ('low','moderate','high')),
    diet_preference TEXT        CHECK (diet_preference IN ('vegetarian','vegan','non_vegetarian','eggetarian','other')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'client_fitness_profiles table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS cfp_client_idx ON client_fitness_profiles (client_id);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'client_fitness_profiles index: %', SQLERRM; END $$;


-- ─── CHURN RISK LOG ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS churn_risk_log (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    risk_score      INT         NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    risk_level      TEXT        NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
    reason          TEXT,
    suggested_action TEXT,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'churn_risk_log table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS crl_client_idx ON churn_risk_log (client_id);
  CREATE INDEX IF NOT EXISTS crl_risk_idx   ON churn_risk_log (risk_score DESC);
  CREATE INDEX IF NOT EXISTS crl_active_idx ON churn_risk_log (resolved_at) WHERE resolved_at IS NULL;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'churn_risk_log indexes: %', SQLERRM; END $$;


-- ─── SEED DATA (exercises and diet templates) ─────────────────
-- Only insert if the tables exist and are empty.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'exercises') THEN
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Bench Press', 'Barbell bench press for chest development', 'Chest', 'intermediate', 4, 10
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Bench Press');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Incline Dumbbell Press', 'Dumbbell press on incline bench for upper chest', 'Chest', 'intermediate', 3, 12
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Incline Dumbbell Press');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Push Ups', 'Bodyweight chest and triceps exercise', 'Chest', 'beginner', 3, 15
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Push Ups');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Lat Pulldown', 'Wide grip lat pulldown for back width', 'Back', 'intermediate', 3, 12
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Lat Pulldown');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Barbell Row', 'Barbell bent-over row for back thickness', 'Back', 'intermediate', 4, 10
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Barbell Row');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Pull Ups', 'Bodyweight back and biceps compound', 'Back', 'advanced', 3, 8
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Pull Ups');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Squat', 'Barbell back squat for leg development', 'Legs', 'intermediate', 4, 10
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Squat');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Leg Press', 'Machine leg press for quad and glute development', 'Legs', 'beginner', 3, 12
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Leg Press');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Deadlift', 'Conventional barbell deadlift for posterior chain', 'Legs', 'advanced', 4, 8
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Deadlift');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Shoulder Press', 'Barbell overhead press for shoulder development', 'Shoulders', 'intermediate', 3, 10
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Shoulder Press');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Lateral Raise', 'Dumbbell lateral raise for side delts', 'Shoulders', 'beginner', 3, 15
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Lateral Raise');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Bicep Curl', 'Dumbbell bicep curl for arm development', 'Arms', 'beginner', 3, 12
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Bicep Curl');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Tricep Pushdown', 'Cable tricep pushdown for tricep isolation', 'Arms', 'beginner', 3, 12
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Tricep Pushdown');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Plank', 'Core stability hold exercise', 'Core', 'beginner', 3, 30
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Plank');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Cable Crunch', 'Cable crunch for abdominal development', 'Core', 'intermediate', 3, 15
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Cable Crunch');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Treadmill Running', 'Cardio running on treadmill', 'Cardio', 'beginner', 1, 20
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Treadmill Running');
    INSERT INTO exercises (id, name, description, muscle_group, difficulty, sets_default, reps_default)
    SELECT gen_random_uuid()::TEXT, 'Jump Rope', 'Jump rope for cardiovascular conditioning', 'Cardio', 'intermediate', 3, 60
    WHERE NOT EXISTS (SELECT 1 FROM exercises WHERE name = 'Jump Rope');
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'exercise seed data: %', SQLERRM; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'diet_templates') THEN
    INSERT INTO diet_templates (id, name, description, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g)
    SELECT gen_random_uuid()::TEXT, 'Weight Loss', 'Balanced calorie-deficit meal plan for fat loss', 'weight_loss', 1800, 120, 180, 50
    WHERE NOT EXISTS (SELECT 1 FROM diet_templates WHERE name = 'Weight Loss');
    INSERT INTO diet_templates (id, name, description, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g)
    SELECT gen_random_uuid()::TEXT, 'Muscle Gain', 'High-protein surplus meal plan for muscle building', 'muscle_gain', 2800, 180, 300, 70
    WHERE NOT EXISTS (SELECT 1 FROM diet_templates WHERE name = 'Muscle Gain');
    INSERT INTO diet_templates (id, name, description, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g)
    SELECT gen_random_uuid()::TEXT, 'Maintenance', 'Balanced meal plan for weight maintenance', 'maintenance', 2200, 140, 240, 60
    WHERE NOT EXISTS (SELECT 1 FROM diet_templates WHERE name = 'Maintenance');
    INSERT INTO diet_templates (id, name, description, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g)
    SELECT gen_random_uuid()::TEXT, 'Keto Diet', 'Low-carb high-fat ketogenic meal plan', 'keto', 2000, 130, 30, 150
    WHERE NOT EXISTS (SELECT 1 FROM diet_templates WHERE name = 'Keto Diet');
    INSERT INTO diet_templates (id, name, description, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g)
    SELECT gen_random_uuid()::TEXT, 'Vegan Plan', 'Plant-based protein-rich meal plan for vegans', 'vegan', 2200, 130, 260, 55
    WHERE NOT EXISTS (SELECT 1 FROM diet_templates WHERE name = 'Vegan Plan');
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'diet template seed data: %', SQLERRM; END $$;
