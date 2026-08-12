-- ============================================================
-- 012_business_flow_complete.sql
-- Completes the full business flow:
--   Lead CRM → Member → PT → Session → Progress → Finance → Communication → Reports
-- ============================================================

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS leads (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    mobile          TEXT,
    email           TEXT,
    gender          TEXT        CHECK (gender IN ('Male','Female','Other')),
    source          TEXT        NOT NULL DEFAULT 'walk_in'
                    CHECK (source IN ('website','instagram','whatsapp','referral','walk_in','call','other')),
    status          TEXT        NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','contacted','follow_up','interested','not_interested','trial_booked','converted','lost')),
    interest        TEXT        CHECK (interest IN ('membership','pt','both','trial')),
    notes           TEXT,
    assigned_to     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    branch_id       TEXT,
    converted_to_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
    converted_at    TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'leads table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
  CREATE INDEX IF NOT EXISTS leads_source_idx ON leads (source);
  CREATE INDEX IF NOT EXISTS leads_assigned_idx ON leads (assigned_to);
  CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'leads indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS lead_followups (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    lead_id         TEXT        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    followup_type   TEXT        NOT NULL DEFAULT 'call'
                    CHECK (followup_type IN ('call','whatsapp','sms','visit','email','other')),
    outcome         TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (outcome IN ('pending','reached','not_reached','interested','not_interested','callback_scheduled','converted')),
    notes           TEXT,
    scheduled_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    performed_by    TEXT        REFERENCES users(id) ON DELETE SET NULL,
    next_followup_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lead_followups table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS lf_lead_idx ON lead_followups (lead_id);
  CREATE INDEX IF NOT EXISTS lf_scheduled_idx ON lead_followups (scheduled_at);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lead_followups indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS trial_sessions (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    lead_id         TEXT        REFERENCES leads(id) ON DELETE SET NULL,
    client_id       TEXT        REFERENCES clients(id) ON DELETE SET NULL,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
    status          TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','cancelled','no_show')),
    feedback        TEXT,
    converted       BOOLEAN     DEFAULT FALSE,
    notes           TEXT,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'trial_sessions table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS ts_lead_idx ON trial_sessions (lead_id);
  CREATE INDEX IF NOT EXISTS ts_status_idx ON trial_sessions (status);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'trial_sessions indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_goals (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    goal_type       TEXT        NOT NULL
                    CHECK (goal_type IN ('fat_loss','muscle_gain','strength','powerlifting','endurance','general_fitness','recovery','other')),
    goal_other      TEXT,
    target_weight   NUMERIC(6,2),
    target_body_fat NUMERIC(4,1),
    target_date     DATE,
    notes           TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pg_client_idx ON pt_goals (client_id);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_goals indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_assessments (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
    assessment_date DATE        NOT NULL DEFAULT CURRENT_DATE,
    assessment_type TEXT        NOT NULL DEFAULT 'initial'
                    CHECK (assessment_type IN ('initial','monthly','quarterly','follow_up')),
    weight          NUMERIC(6,2),
    height_cm       NUMERIC(5,1),
    body_fat_pct    NUMERIC(4,1),
    muscle_mass_pct NUMERIC(4,1),
    bmi             NUMERIC(4,1),
    chest_cm        NUMERIC(5,1),
    waist_cm        NUMERIC(5,1),
    hips_cm         NUMERIC(5,1),
    arms_cm         NUMERIC(5,1),
    thighs_cm       NUMERIC(5,1),
    flexibility_score INT,
    cardio_score    INT,
    strength_score  INT,
    posture_notes   TEXT,
    health_notes    TEXT,
    trainer_notes   TEXT,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_assessments table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pa_client_idx ON pt_assessments (client_id);
  CREATE INDEX IF NOT EXISTS pa_date_idx ON pt_assessments (assessment_date DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_assessments indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS strength_logs (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    exercise_name   TEXT        NOT NULL,
    weight_kg       NUMERIC(6,2) NOT NULL,
    sets_done       INT         DEFAULT 3,
    reps_done       INT         DEFAULT 10,
    one_rm_estimate NUMERIC(6,2),
    log_date        DATE        NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'strength_logs table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS sl_client_idx ON strength_logs (client_id, log_date DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'strength_logs indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS progress_photos (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    photo_url       TEXT        NOT NULL,
    photo_type      TEXT        NOT NULL DEFAULT 'front'
                    CHECK (photo_type IN ('front','side','back','flexed','full_body','other')),
    taken_at        DATE        NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,
    uploaded_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'progress_photos table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pp_client_idx ON progress_photos (client_id, taken_at DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'progress_photos indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS session_balance (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    total_sessions  INT         NOT NULL DEFAULT 0,
    used_sessions   INT         NOT NULL DEFAULT 0,
    remaining_sessions INT GENERATED ALWAYS AS (total_sessions - used_sessions) STORED,
    package_name    TEXT,
    start_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    end_date        DATE,
    status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','expired')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, package_name)
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'session_balance table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS sb_client_idx ON session_balance (client_id);
  CREATE INDEX IF NOT EXISTS sb_low_idx ON session_balance (remaining_sessions) WHERE remaining_sessions <= 3 AND status = 'active';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'session_balance indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS automation_rules (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL,
    trigger_event   TEXT        NOT NULL
                    CHECK (trigger_event IN (
                      'member_created','lead_created','followup_due','membership_expiring',
                      'membership_expired','payment_received','session_low','birthday',
                      'anniversary','attendance_missed','trial_scheduled','trial_completed'
                    )),
    channel         TEXT        NOT NULL DEFAULT 'whatsapp'
                    CHECK (channel IN ('whatsapp','sms','email','push')),
    template        TEXT        NOT NULL,
    delay_minutes   INT         DEFAULT 0,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    last_run_at     TIMESTAMPTZ,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'automation_rules table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS ar_trigger_idx ON automation_rules (trigger_event);
  CREATE INDEX IF NOT EXISTS ar_active_idx ON automation_rules (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'automation_rules indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS communication_logs (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    recipient_type  TEXT        NOT NULL CHECK (recipient_type IN ('lead','client','trainer','staff')),
    recipient_id    TEXT        NOT NULL,
    recipient_name  TEXT,
    recipient_phone TEXT,
    channel         TEXT        NOT NULL CHECK (channel IN ('whatsapp','sms','email','push')),
    direction       TEXT        NOT NULL DEFAULT 'outgoing' CHECK (direction IN ('outgoing','incoming')),
    template        TEXT,
    message         TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('queued','sent','delivered','read','failed','bounced')),
    external_id     TEXT,
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    read_at         TIMESTAMPTZ,
    automation_rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'communication_logs table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS cl_recipient_idx ON communication_logs (recipient_type, recipient_id);
  CREATE INDEX IF NOT EXISTS cl_channel_idx ON communication_logs (channel, created_at DESC);
  CREATE INDEX IF NOT EXISTS cl_status_idx ON communication_logs (status);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'communication_logs indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS weekly_checkins (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    week_start_date DATE        NOT NULL,
    weight          NUMERIC(6,2),
    mood            TEXT        CHECK (mood IN ('great','good','okay','tired','stressed')),
    sleep_hours     NUMERIC(3,1),
    water_glasses   INT,
    workout_count   INT         DEFAULT 0,
    calories_avg    INT,
    adherence_pct   INT         CHECK (adherence_pct BETWEEN 0 AND 100),
    trainer_notes   TEXT,
    client_notes    TEXT,
    created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, week_start_date)
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'weekly_checkins table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS wc_client_idx ON weekly_checkins (client_id, week_start_date DESC);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'weekly_checkins indexes: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS pt_packages (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    name            TEXT        NOT NULL UNIQUE,
    session_count   INT         NOT NULL CHECK (session_count > 0),
    duration_days   INT         NOT NULL CHECK (duration_days > 0),
    price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    goal_type       TEXT        CHECK (goal_type IN ('fat_loss','muscle_gain','strength','powerlifting','endurance','general_fitness','recovery')),
    description     TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_packages table: %', SQLERRM; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS pp_active_idx ON pt_packages (is_active);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pt_packages indexes: %', SQLERRM; END $$;

-- Seed default PT packages
INSERT INTO pt_packages (name, session_count, duration_days, price, goal_type, description) VALUES
  ('Fat Loss - 12 Sessions', 12, 30, 3000, 'fat_loss', '12 PT sessions focused on fat loss over 1 month'),
  ('Fat Loss - 24 Sessions', 24, 60, 5500, 'fat_loss', '24 PT sessions for fat loss over 2 months'),
  ('Muscle Gain - 12 Sessions', 12, 30, 3500, 'muscle_gain', '12 PT sessions for muscle building over 1 month'),
  ('Muscle Gain - 24 Sessions', 24, 60, 6500, 'muscle_gain', '24 PT sessions for muscle building over 2 months'),
  ('Strength - 12 Sessions', 12, 30, 3000, 'strength', '12 PT sessions focused on strength'),
  ('Powerlifting - 24 Sessions', 24, 60, 7500, 'powerlifting', '24 PT sessions for powerlifting'),
  ('General Fitness - 8 Sessions', 8, 30, 2000, 'general_fitness', '8 sessions general fitness training')
ON CONFLICT (name) DO NOTHING;
