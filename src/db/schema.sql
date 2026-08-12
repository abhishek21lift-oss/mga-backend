-- ============================================================
-- MY PT STUDIO ERP — Full Database Schema v4.0
-- PostgreSQL 14+
--
-- Run order:
--   1. extensions
--   2. core tables (users, trainers, clients)
--   3. membership & finance (subscriptions, payments, renewals)
--   4. attendance
--   5. face recognition
--   6. notifications & activity log
--   7. feature flags & settings
--   8. indexes
-- ============================================================

-- ─── Extensions ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- ILIKE trigram indexes
CREATE EXTENSION IF NOT EXISTS "unaccent";   -- accent-insensitive search


-- ─── ENUM types ──────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role    AS ENUM ('admin','manager','trainer','reception','member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE client_status AS ENUM ('active','expired','frozen','pending','lead','inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('CASH','UPI','CARD','BANK_TRANSFER','CHEQUE','FREE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attendance_status AS ENUM ('present','absent','late','half_day');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notif_type AS ENUM (
    'birthday','anniversary','expiry','dues','renewal','system','custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─── USERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password      TEXT        NOT NULL,            -- bcrypt hash
  role          TEXT        NOT NULL DEFAULT 'trainer'
                            CHECK (role IN ('admin','manager','trainer','reception','member')),
  -- The two FKs these columns carry are attached further down, once trainers
  -- and clients exist. Declaring them inline made this file unrunnable in its
  -- own stated order: users is defined first, so both targets are still
  -- missing at this point and a fresh database stopped here.
  trainer_id    TEXT,
  member_id     TEXT,
  branch_id     TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));


-- ─── TRAINERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trainers (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name             TEXT        NOT NULL,
  email            TEXT,
  mobile           TEXT,
  dob              DATE,
  gender           TEXT        CHECK (gender IN ('Male','Female','Other') OR gender IS NULL),
  address          TEXT,
  role             TEXT        NOT NULL DEFAULT 'Personal Trainer',
  specialization   TEXT,
  bio              TEXT,
  schedule         TEXT,
  certifications   TEXT,        -- comma-separated string (e.g. "K11 Fitness, ACE Certified")
  salary           NUMERIC(12,2) NOT NULL DEFAULT 0,
  incentive_rate   NUMERIC(5,4) NOT NULL DEFAULT 0.5
                               CHECK (incentive_rate BETWEEN 0 AND 1),
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive')),
  joining_date     DATE,
  photo_url        TEXT,
  branch_id        TEXT,
  notes            TEXT,
  biometric_code   TEXT,
  biometric_added  BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── CLIENTS (Members) ───────────────────────────────────────
-- Single source of truth for a gym member.
-- Fields use both modern names (expiry_date, phone) and the legacy
-- column names (pt_end_date, mobile) that the existing API relies on.
-- New columns shadow the old ones via GENERATED or defaults.
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        UNIQUE,      -- legacy FS#### code
  member_code     TEXT        UNIQUE,      -- SIX19-#### display code
  name            TEXT        NOT NULL,
  mobile          TEXT,
  phone           TEXT GENERATED ALWAYS AS (mobile) STORED,  -- alias
  email           TEXT,
  gender          TEXT        CHECK (gender IN ('Male','Female','Other',NULL)),
  dob             DATE,
  address         TEXT,
  emergency_contact TEXT,

  -- Trainer assignment
  trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  trainer_name    TEXT,

  -- Membership details
  package_type    TEXT,        -- plan name
  membership_plan TEXT GENERATED ALWAYS AS (package_type) STORED,
  joining_date    DATE,
  join_date       DATE GENERATED ALWAYS AS (joining_date) STORED,
  pt_start_date   DATE,
  pt_end_date     DATE,
  expiry_date     DATE GENERATED ALWAYS AS (pt_end_date) STORED,
  sessions_per_week INT,

  -- Financials
  base_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount  NUMERIC(12,2) NOT NULL DEFAULT 0
                  CHECK (balance_amount >= 0),
  balance_due     NUMERIC(12,2) GENERATED ALWAYS AS (balance_amount) STORED,
  payment_method  TEXT        DEFAULT 'CASH',
  payment_date    DATE,

  -- Status & metadata
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','expired','frozen','pending','lead','inactive')),
  notes           TEXT,
  photo_url       TEXT,
  weight          NUMERIC(6,2),

  -- Biometric / face recognition
  biometric_code  TEXT,
  biometric_added BOOLEAN     DEFAULT FALSE,
  -- JSONB, which is what migration 013b converts this to and what the code
  -- reads today. Declared in its final shape so a fresh database never needs
  -- the conversion: by the time 013b runs, migration 009 has built the
  -- v_clients view over this column, and Postgres refuses to ALTER the type
  -- of a column a view depends on. 013b's guard checks for the old float8[]
  -- type, so it correctly no-ops here and still upgrades legacy databases.
  face_descriptor JSONB,      -- 128-D face embedding
  face_enrolled   BOOLEAN     DEFAULT FALSE,
  face_enrolled_at TIMESTAMPTZ,

  -- Soft-delete & timestamps
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigram index for fast ILIKE search on name/mobile/email
CREATE INDEX IF NOT EXISTS clients_name_trgm   ON clients USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_mobile_trgm ON clients USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_status_idx  ON clients (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS clients_trainer_idx ON clients (trainer_id);
CREATE INDEX IF NOT EXISTS clients_expiry_idx  ON clients (pt_end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS clients_dob_idx     ON clients (EXTRACT(DOY FROM dob));

-- UNIQUE email indexes (partial — only non-empty emails)
CREATE UNIQUE INDEX IF NOT EXISTS clients_email_uniq  ON clients (LOWER(email))
  WHERE email IS NOT NULL AND email != '';
CREATE UNIQUE INDEX IF NOT EXISTS trainers_email_uniq ON trainers (LOWER(email))
  WHERE email IS NOT NULL AND email != '';

-- The FKs deferred from the users table above, now that both targets exist.
-- users → trainers/clients while trainers/clients are themselves defined
-- after users, so one of the three has to be attached out of line; doing it
-- here keeps the table definitions in their documented reading order.
--
-- Guarded by name rather than IF NOT EXISTS, which ADD CONSTRAINT does not
-- support, so this stays idempotent and leaves a live database — where these
-- constraints already exist — completely untouched.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_trainer_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_trainer_id_fkey
      FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_member_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_member_id_fkey
      FOREIGN KEY (member_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ─── PAYMENTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  receipt_no      TEXT        UNIQUE,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  client_name     TEXT,
  trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  trainer_name    TEXT,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method          TEXT        NOT NULL DEFAULT 'CASH',
  date            DATE        NOT NULL DEFAULT CURRENT_DATE,
  package_type    TEXT,
  incentive_amt   NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_client_idx ON payments (client_id);
CREATE INDEX IF NOT EXISTS payments_date_idx   ON payments (date DESC);
CREATE INDEX IF NOT EXISTS payments_trainer_idx ON payments (trainer_id);


-- ─── RENEWALS ────────────────────────────────────────────────
-- Audit trail of every membership renewal.
CREATE TABLE IF NOT EXISTS renewals (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_name     TEXT,
  trainer_id      TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  trainer_name    TEXT,
  old_package     TEXT,
  new_package     TEXT,
  old_end_date    DATE,
  new_end_date    DATE,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method  TEXT,
  renewed_on      DATE        NOT NULL DEFAULT CURRENT_DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS renewals_client_idx ON renewals (client_id);
CREATE INDEX IF NOT EXISTS renewals_date_idx   ON renewals (renewed_on DESC);


-- ─── SUBSCRIPTIONS ───────────────────────────────────────────
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

-- `plans` must exist before `subscriptions`, which carries an FK to it.
--
-- It was previously created only by migration 003a — which runs AFTER this
-- file — so a fresh database failed here with "relation plans does not
-- exist", took `subscriptions` down with it, and then failed migration 001
-- for the missing `users` that the aborted run never reached. The live
-- database has never seen this because it predates the split.
--
-- The full column set, defaults and the `features` TEXT→JSONB upgrade still
-- live in 003a. This is the minimum shape the FK below needs; 003a's
-- ADD COLUMN IF NOT EXISTS statements fill in the rest and remain a no-op on
-- any database that already has them.
CREATE TABLE IF NOT EXISTS plans (
  id                TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  kind              TEXT          NOT NULL DEFAULT 'Membership'
                                  CHECK (kind IN ('Membership','PT')),
  name              TEXT          NOT NULL,
  duration          TEXT          NOT NULL DEFAULT 'Monthly'
                                  CHECK (duration IN ('Monthly','Quarterly','Half Yearly','Yearly')),
  base_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  final_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  sessions_per_week INT,
  features          JSONB         NOT NULL DEFAULT '[]',
  popular           BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT          NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_id           TEXT          REFERENCES plans(id),
  plan_name         TEXT          NOT NULL,
  plan_type         TEXT          NOT NULL CHECK (plan_type IN ('Membership','PT','AddOn')),
  start_date        DATE          NOT NULL,
  end_date          DATE          NOT NULL,
  amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  base_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  signup_fee        NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method    TEXT          NOT NULL DEFAULT 'CASH',
  payment_status    TEXT          NOT NULL DEFAULT 'PAID'
                    CHECK (payment_status IN ('PAID','PENDING','PARTIAL','REFUNDED')),
  receipt_no        TEXT,
  coupon_code       TEXT,
  branch_id         TEXT          REFERENCES branches(id),
  group_id          TEXT,
  trainer_id        TEXT          REFERENCES trainers(id),
  performed_by      TEXT,
  status            TEXT          NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','cancelled','frozen','superseded')),
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_client_idx  ON subscriptions (client_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx  ON subscriptions (status);
CREATE INDEX IF NOT EXISTS subscriptions_end_idx     ON subscriptions (end_date);


-- ─── ATTENDANCE LOGS ─────────────────────────────────────────
-- Unified table for both client and trainer/staff attendance.
-- ref_type = 'client'  → ref_id = clients.id
-- ref_type = 'trainer' → ref_id = trainers.id
CREATE TABLE IF NOT EXISTS attendance_logs (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  ref_id          TEXT        NOT NULL,
  ref_type        TEXT        NOT NULL DEFAULT 'client'
                  CHECK (ref_type IN ('client','trainer')),
  ref_name        TEXT,
  date            DATE        NOT NULL DEFAULT CURRENT_DATE,
  check_in_time   TIMESTAMPTZ,
  check_out_time  TIMESTAMPTZ,
  method          TEXT        NOT NULL DEFAULT 'manual'
                  CHECK (method IN ('face','manual','qr','biometric')),
  status          TEXT        NOT NULL DEFAULT 'present'
                  CHECK (status IN ('present','absent','late','half_day')),
  notes           TEXT,
  marked_by       TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ref_id, ref_type, date)
);

CREATE INDEX IF NOT EXISTS atlog_ref_idx  ON attendance_logs (ref_id, ref_type);
CREATE INDEX IF NOT EXISTS atlog_date_idx ON attendance_logs (date DESC);
CREATE INDEX IF NOT EXISTS atlog_type_idx ON attendance_logs (ref_type, date DESC);


-- ─── ATTENDANCE (class-booking mirror) ───────────────────────
-- Distinct from attendance_logs above, and NOT a leftover: the bookings and
-- members services read and write this table today
-- (modules/bookings/bookings.service.js mirrors a check-in into it,
-- modules/members/members.service.js reads a member's history out of it).
--
-- It was never in any tracked file — it exists on the live database because
-- it was created out of band, exactly like the `exercises` columns that
-- migration 069 later reconciled. The visible symptom was migration 010
-- failing on a fresh database with "relation attendance does not exist" when
-- it tried to index it.
--
-- The shape is taken from what the code actually uses; the composite UNIQUE
-- is required by the bookings service's ON CONFLICT (type, ref_id, date).
-- IF NOT EXISTS, so a database that already has its own copy keeps it
-- untouched.
CREATE TABLE IF NOT EXISTS attendance (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  type             TEXT        NOT NULL DEFAULT 'client'
                   CHECK (type IN ('client','trainer','staff')),
  ref_id           TEXT        NOT NULL,
  member_id        TEXT,
  booking_id       TEXT,
  branch_id        TEXT        REFERENCES branches(id),
  date             DATE        NOT NULL DEFAULT CURRENT_DATE,
  check_in         TIME,
  check_out        TIME,
  status           TEXT        NOT NULL DEFAULT 'present'
                   CHECK (status IN ('present','absent','late','half_day')),
  check_in_method  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (type, ref_id, date)
);


-- ─── FACE DESCRIPTORS ────────────────────────────────────────
-- Separate table keeps the heavy 128-float arrays out of the main
-- clients row, speeding up list queries.
CREATE TABLE IF NOT EXISTS face_descriptors (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id     TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- JSONB for the same reason as clients.face_descriptor above: this is what
  -- migration 013b converts it to, and declaring the end state here keeps the
  -- two columns the same type so migration 001's copy between them works on a
  -- fresh database.
  descriptor    JSONB       NOT NULL,  -- 128-D face-api.js embedding
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ,
  enrolled_by   TEXT        REFERENCES users(id) ON DELETE SET NULL,
  model_version TEXT        NOT NULL DEFAULT 'face-api-v1',
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS face_desc_client_idx ON face_descriptors (client_id) WHERE is_active;


-- ─── FACE CHECKIN LOGS ───────────────────────────────────────
-- Audit log of every face recognition check-in attempt.
CREATE TABLE IF NOT EXISTS face_checkin_logs (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id   TEXT        REFERENCES clients(id) ON DELETE SET NULL,
  status      TEXT        NOT NULL DEFAULT 'unknown'
              CHECK (status IN ('success','failed','unknown','expired','denied','frozen','error','enrolled','revoked')),
  distance    FLOAT8,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS face_log_client_idx ON face_checkin_logs (client_id);
CREATE INDEX IF NOT EXISTS face_log_date_idx   ON face_checkin_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS face_log_status_idx ON face_checkin_logs (status);


-- ─── WEIGHT LOGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weight_logs (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  weight      NUMERIC(6,2) NOT NULL,
  date        DATE    NOT NULL DEFAULT CURRENT_DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wlog_client_idx ON weight_logs (client_id, date DESC);


-- ─── NOTIFICATIONS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT    REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body        TEXT,
  ref_id      TEXT,            -- optional: client_id, payment_id, etc.
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications (user_id, is_read, created_at DESC);


-- ─── ACTIVITY LOG ────────────────────────────────────────────
-- Immutable audit trail for all write operations.
CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  user_name   TEXT,
  action      TEXT    NOT NULL,  -- e.g. 'client.create', 'payment.delete'
  entity_type TEXT,              -- 'client', 'payment', 'trainer', …
  entity_id   TEXT,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS actlog_user_idx   ON activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actlog_entity_idx ON activity_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS actlog_date_idx   ON activity_log (created_at DESC);


-- ─── FEATURE FLAGS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT    PRIMARY KEY,
  value       BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feature_flags (key, value, description) VALUES
  ('face_checkin',       TRUE,  'Enable face recognition check-in'),
  ('voice_feedback',     TRUE,  'Enable voice feedback on check-in'),
  ('birthday_reminders', TRUE,  'Send birthday notifications'),
  ('auto_expire',        TRUE,  'Auto-expire memberships past end date')
ON CONFLICT (key) DO NOTHING;


-- ─── SYSTEM SETTINGS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT,
  type        TEXT    NOT NULL DEFAULT 'string'
              CHECK (type IN ('string','number','boolean','json')),
  description TEXT,
  updated_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value, type, description) VALUES
  ('gym_name',            'MY PT STUDIO', 'string', 'Studio display name'),
  ('gym_phone',           '',                   'string', 'Contact phone number'),
  ('gym_address',         '',                   'string', 'Studio address'),
  ('currency',            'INR',                'string', 'Currency code'),
  ('expiry_warn_days',    '30',                 'number', 'Days before expiry to warn'),
  ('face_match_threshold','0.50',               'number', 'Face recognition distance threshold'),
  ('timezone',            'Asia/Kolkata',       'string', 'Server timezone')
ON CONFLICT (key) DO NOTHING;


-- ─── RECEIPT COUNTER ─────────────────────────────────────────
-- Used by genReceiptNo() in db/receipts.js — a single-row atomic counter.
CREATE TABLE IF NOT EXISTS receipt_counter (
  id           SERIAL  PRIMARY KEY,
  last_receipt INT     NOT NULL DEFAULT 0
);

INSERT INTO receipt_counter (last_receipt)
SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM receipt_counter);


-- ─── LEAVE REQUESTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trainer_id  TEXT    NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  leave_type  TEXT    NOT NULL DEFAULT 'other'
              CHECK (leave_type IN ('sick','casual','earned','emergency','unpaid','other')),
  from_date   DATE    NOT NULL,
  to_date     DATE    NOT NULL,
  reason      TEXT,
  admin_note  TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  approved_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leave_trainer_idx ON leave_requests (trainer_id);
CREATE INDEX IF NOT EXISTS leave_status_idx  ON leave_requests (status);


-- ─── Expenses table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL DEFAULT 'other',
  description     TEXT NOT NULL DEFAULT '',
  amount          DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  receipt_url     TEXT,
  notes           TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'approved'
                    CHECK (status IN ('pending','approved','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_date_idx    ON expenses (expense_date);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category);
CREATE INDEX IF NOT EXISTS expenses_status_idx  ON expenses (status);


-- ─── HELPER FUNCTION — updated_at trigger ────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ DECLARE
  t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY['users','trainers','clients','subscriptions','branches','system_settings','leave_requests','expenses'])
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
