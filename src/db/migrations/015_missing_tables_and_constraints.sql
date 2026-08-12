-- Migration 015: Add missing tables, constraints, and indexes
-- Created: 2026-05-31
-- 
-- This migration adds tables that are referenced by existing FK
-- constraints and application code but were never created in schema.sql
-- or any prior migration.

-- ─── BRANCHES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name        TEXT        NOT NULL,
  code        TEXT        UNIQUE,
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  manager     TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO branches (id, name, code)
VALUES ('main', 'Main Studio', 'MAIN')
ON CONFLICT (code) DO NOTHING;

-- ─── ALL TABLES (CREATE IF NOT EXISTS) ───────────────────────
CREATE TABLE IF NOT EXISTS class_templates (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name          TEXT        NOT NULL,
  description   TEXT,
  category      TEXT,
  duration_min  INT         NOT NULL DEFAULT 60,
  capacity      INT         NOT NULL DEFAULT 20,
  color         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  template_id     TEXT        REFERENCES class_templates(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  description     TEXT,
  instructor_id   TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  instructor_name TEXT,
  date            DATE        NOT NULL,
  start_time      TIME        NOT NULL,
  end_time        TIME        NOT NULL,
  capacity        INT         NOT NULL DEFAULT 20,
  booked_count    INT         NOT NULL DEFAULT 0,
  location        TEXT,
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  session_id      TEXT        NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  client_id       TEXT        REFERENCES clients(id) ON DELETE CASCADE,
  member_id       TEXT,
  client_name     TEXT,
  status          TEXT        NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed','checked_in','cancelled','no_show')),
  checked_in_at   TIMESTAMPTZ,
  booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS members (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  user_id         TEXT        UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  email           TEXT,
  phone           TEXT,
  profile_pic     TEXT,
  date_of_birth   DATE,
  emergency_contact TEXT,
  preferences     JSONB       DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_memberships (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  member_id       TEXT        NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subscription_id TEXT        REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_name       TEXT        NOT NULL,
  start_date      DATE        NOT NULL,
  end_date        DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','cancelled','frozen')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holds_freezes (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subscription_id TEXT        REFERENCES subscriptions(id) ON DELETE CASCADE,
  reason          TEXT,
  freeze_from     DATE        NOT NULL,
  freeze_until    DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired')),
  created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS body_metrics (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  weight          NUMERIC(6,2),
  body_fat_pct    NUMERIC(5,2),
  muscle_mass     NUMERIC(6,2),
  bmi             NUMERIC(5,2),
  chest           NUMERIC(6,2),
  waist           NUMERIC(6,2),
  hips            NUMERIC(6,2),
  arms            NUMERIC(6,2),
  thighs          NUMERIC(6,2),
  notes           TEXT,
  measured_at     DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pt_sessions (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  session_date    DATE        NOT NULL,
  start_time      TIME,
  end_time        TIME,
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  notes           TEXT,
  created_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  table_name      TEXT        NOT NULL,
  record_id       TEXT,
  action          TEXT        NOT NULL,
  old_data        JSONB,
  new_data        JSONB,
  changed_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ENSURE ALL COLUMNS EXIST (pre-existing tables may lack them) ─
-- If any table was created by the original DB schema, its columns may
-- differ from what this migration expects.  ADD COLUMN IF NOT EXISTS
-- guarantees every column is present before indexes are created below.
DO $$ BEGIN
  -- class_sessions
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS template_id     TEXT;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS title           TEXT NOT NULL DEFAULT '';
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS description     TEXT;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS instructor_id   TEXT;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS instructor_name TEXT;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS date            DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS start_time      TIME NOT NULL DEFAULT '00:00:00';
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS end_time        TIME NOT NULL DEFAULT '00:00:00';
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS capacity        INT NOT NULL DEFAULT 20;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS booked_count    INT NOT NULL DEFAULT 0;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS location        TEXT;
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'scheduled';
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- bookings
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS session_id      TEXT NOT NULL DEFAULT '';
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS client_id       TEXT;
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS member_id       TEXT;
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS client_name     TEXT;
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'confirmed';
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS checked_in_at   TIMESTAMPTZ;
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS booked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- members
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS client_id       TEXT NOT NULL DEFAULT '';
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS user_id         TEXT;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS email           TEXT;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS phone           TEXT;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS profile_pic     TEXT;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS date_of_birth   DATE;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS emergency_contact TEXT;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS preferences     JSONB DEFAULT '{}';
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE members       ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- member_memberships
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS member_id       TEXT NOT NULL DEFAULT '';
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS subscription_id TEXT;
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS plan_name       TEXT NOT NULL DEFAULT '';
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS start_date      DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS end_date        DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE member_memberships ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- holds_freezes
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS client_id       TEXT NOT NULL DEFAULT '';
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS subscription_id TEXT;
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS reason          TEXT;
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS freeze_from     DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS freeze_until    DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS created_by      TEXT;
  ALTER TABLE holds_freezes ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- body_metrics
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS client_id       TEXT NOT NULL DEFAULT '';
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS weight          NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS body_fat_pct    NUMERIC(5,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS muscle_mass     NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS bmi             NUMERIC(5,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS chest           NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS waist           NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS hips            NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS arms            NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS thighs          NUMERIC(6,2);
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS notes           TEXT;
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS measured_at     DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE body_metrics  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- pt_sessions
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS client_id       TEXT NOT NULL DEFAULT '';
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS trainer_id      TEXT;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS session_date    DATE NOT NULL DEFAULT CURRENT_DATE;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS start_time      TIME;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS end_time        TIME;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'scheduled';
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS notes           TEXT;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS created_by      TEXT;
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE pt_sessions   ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- audit_log
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS table_name      TEXT NOT NULL DEFAULT '';
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS record_id       TEXT;
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS action          TEXT NOT NULL DEFAULT '';
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS old_data        JSONB;
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS new_data        JSONB;
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS changed_by      TEXT;
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS ip_address      TEXT;
  ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- class_templates
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS name          TEXT NOT NULL DEFAULT '';
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS description   TEXT;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS category      TEXT;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS duration_min  INT NOT NULL DEFAULT 60;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS capacity      INT NOT NULL DEFAULT 20;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS color         TEXT;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─── INDEXES ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS cs_date_idx         ON class_sessions (date);
CREATE INDEX IF NOT EXISTS cs_instructor_idx   ON class_sessions (instructor_id);
CREATE INDEX IF NOT EXISTS cs_status_idx       ON class_sessions (status);
CREATE INDEX IF NOT EXISTS bookings_session_idx ON bookings (session_id);
CREATE INDEX IF NOT EXISTS bookings_client_idx  ON bookings (client_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_session_client_uniq
  ON bookings (session_id, COALESCE(client_id, member_id))
  WHERE status IN ('confirmed','checked_in');
CREATE INDEX IF NOT EXISTS mm_member_idx       ON member_memberships (member_id);
CREATE INDEX IF NOT EXISTS mm_status_idx       ON member_memberships (status);
CREATE INDEX IF NOT EXISTS hf_client_idx       ON holds_freezes (client_id);
CREATE INDEX IF NOT EXISTS bm_client_idx       ON body_metrics (client_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS pts_client_idx      ON pt_sessions (client_id, session_date DESC);
CREATE INDEX IF NOT EXISTS pts_trainer_idx     ON pt_sessions (trainer_id, session_date DESC);
CREATE INDEX IF NOT EXISTS pts_date_idx        ON pt_sessions (session_date);
CREATE INDEX IF NOT EXISTS audit_table_idx     ON audit_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS audit_date_idx      ON audit_log (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS clients_mobile_uniq ON clients (mobile)
  WHERE mobile IS NOT NULL AND mobile != '';
-- staff_targets is created by migration 033, i.e. AFTER this one, so on a
-- fresh database this index has nothing to attach to and the whole migration
-- aborts. It only worked on the live database because that table already
-- existed there by the time this file first ran. Guarded rather than moved:
-- 015 and 033 are both applied in production already, so reordering them
-- would change nothing there and risk diverging the two histories. 033
-- creates its own index on this column, so a fresh database still ends up
-- fully indexed.
DO $$ BEGIN
  IF to_regclass('public.staff_targets') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS st_staff_idx ON staff_targets (staff_id);
  END IF;
END $$;

-- ─── UPDATED-AT TRIGGERS ─────────────────────────────────────
DO $$ DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['payments','renewals','notifications','activity_log',
                               'face_descriptors','weight_logs','body_metrics',
                               'pt_sessions','branches','members','member_memberships',
                               'bookings','class_sessions','class_templates'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at
           BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END $$;
