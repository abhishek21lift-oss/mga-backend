-- ============================================================
-- 619 ERP — Migration 001: v4.0 Upgrade
-- Safe to run on an existing v3 database.
-- All statements use IF NOT EXISTS / DO NOTHING / ADD COLUMN IF NOT EXISTS
-- so they are idempotent (safe to re-run).
-- ============================================================

-- ─── 1. Enable required extensions ──────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ─── 2. Add soft-delete columns ─────────────────────────────
ALTER TABLE clients  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ─── 3. Add new client columns ──────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS emergency_contact    TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sessions_per_week    INT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS face_enrolled        BOOLEAN DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS face_enrolled_at     TIMESTAMPTZ;

-- face_descriptor on clients kept for backward compat; new code uses face_descriptors table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS face_descriptor      FLOAT8[];

-- ─── 4. Add new trainer columns ─────────────────────────────
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS bio              TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS schedule         TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS certifications   TEXT[];
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;

-- ─── 5. Add member_id to users ──────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS member_id  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id  TEXT;

-- ─── 6. Create new tables (if not exist) ────────────────────

-- attendance_logs (unified) — replaces old separate tables if present
CREATE TABLE IF NOT EXISTS attendance_logs (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  ref_id         TEXT        NOT NULL,
  ref_type       TEXT        NOT NULL DEFAULT 'client'
                 CHECK (ref_type IN ('client','trainer')),
  ref_name       TEXT,
  date           DATE        NOT NULL DEFAULT CURRENT_DATE,
  check_in_time  TIMESTAMPTZ,
  check_out_time TIMESTAMPTZ,
  method         TEXT        NOT NULL DEFAULT 'manual'
                 CHECK (method IN ('face','manual','qr','biometric')),
  status         TEXT        NOT NULL DEFAULT 'present'
                 CHECK (status IN ('present','absent','late','half_day')),
  notes          TEXT,
  marked_by      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ref_id, ref_type, date)
);

-- Migrate data from old attendance table if it exists
-- NOTE: v3 attendance table has no 'method' column — use literal 'manual'
-- Guarded on the v3 COLUMN, not just the table name. `attendance` is now
-- created by schema.sql (the bookings and members services still use it), so
-- a table-name check is true on a brand-new database too — and this block
-- then failed on `ref_name`, a column only the v3 shape ever had. Checking
-- for that column is what actually distinguishes "there is legacy data to
-- migrate" from "this is a fresh install with nothing to copy".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'attendance' AND column_name = 'ref_name'
  ) THEN
    INSERT INTO attendance_logs (ref_id, ref_type, ref_name, date, check_in_time, method, status, created_at)
    SELECT
      ref_id,
      COALESCE(type, 'client'),
      ref_name,
      date::date,
      (date || ' ' || COALESCE(check_in, '09:00'))::TIMESTAMPTZ,
      'manual',
      COALESCE(status, 'present'),
      COALESCE(created_at, NOW())
    FROM attendance
    ON CONFLICT (ref_id, ref_type, date) DO NOTHING;
  END IF;
END $$;

-- face_descriptors (separate table for 128-D embeddings)
CREATE TABLE IF NOT EXISTS face_descriptors (
  id            TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id     TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  descriptor    FLOAT8[] NOT NULL,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_by   TEXT,
  model_version TEXT    NOT NULL DEFAULT 'face-api-v1',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- Migrate existing face_descriptor arrays from clients table
INSERT INTO face_descriptors (client_id, descriptor, is_active)
SELECT id, face_descriptor, TRUE
FROM clients
WHERE face_descriptor IS NOT NULL
  AND face_enrolled = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM face_descriptors fd WHERE fd.client_id = clients.id
  )
ON CONFLICT DO NOTHING;

-- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT    REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT,
  ref_id     TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Guard: table may pre-exist without these columns
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id    TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type       TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title      TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body       TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_id     TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- activity_log
CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT    NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Guard: table may pre-exist without these columns
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_id     TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_name   TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS action      TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entity_id   TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS old_data    JSONB;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS new_data    JSONB;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS ip_address  TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_agent  TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- feature_flags
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT    PRIMARY KEY,
  value       BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS value       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO feature_flags (key, value, description) VALUES
  ('face_checkin',       TRUE,  'Enable face recognition check-in'),
  ('voice_feedback',     TRUE,  'Enable voice feedback on check-in'),
  ('birthday_reminders', TRUE,  'Send birthday notifications'),
  ('auto_expire',        TRUE,  'Auto-expire memberships past end date')
ON CONFLICT (key) DO NOTHING;

-- system_settings
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT,
  type        TEXT    NOT NULL DEFAULT 'string',
  description TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value       TEXT;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS type        TEXT NOT NULL DEFAULT 'string';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS updated_by  TEXT;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO system_settings (key, value, type, description) VALUES
  ('gym_name',            '619 Fitness Studio', 'string', 'Studio display name'),
  ('gym_phone',           '',                   'string', 'Contact phone number'),
  ('gym_address',         '',                   'string', 'Studio address'),
  ('currency',            'INR',                'string', 'Currency code'),
  ('expiry_warn_days',    '30',                 'number', 'Days before expiry to warn'),
  ('face_match_threshold','0.50',               'number', 'Face recognition distance threshold'),
  ('timezone',            'Asia/Kolkata',       'string', 'Server timezone')
ON CONFLICT (key) DO NOTHING;

-- leave_requests
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

-- Safe migration for existing leave_requests tables (add new columns)
DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type TEXT NOT NULL DEFAULT 'other';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS admin_note TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- weight_logs (if not already present from v3)
CREATE TABLE IF NOT EXISTS weight_logs (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  weight      NUMERIC(6,2) NOT NULL,
  date        DATE    NOT NULL DEFAULT CURRENT_DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- receipt_counter (idempotent seed)
CREATE TABLE IF NOT EXISTS receipt_counter (
  id           SERIAL PRIMARY KEY,
  last_receipt INT    NOT NULL DEFAULT 0
);
INSERT INTO receipt_counter (last_receipt)
SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM receipt_counter);

-- ─── 7. Add missing indexes ──────────────────────────────────
CREATE INDEX IF NOT EXISTS clients_name_trgm    ON clients USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_mobile_trgm  ON clients USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_status_idx   ON clients (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS clients_expiry_idx   ON clients (pt_end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS clients_dob_idx      ON clients (EXTRACT(DOY FROM dob));
CREATE INDEX IF NOT EXISTS payments_date_idx    ON payments (date DESC);
CREATE INDEX IF NOT EXISTS atlog_ref_idx        ON attendance_logs (ref_id, ref_type);
CREATE INDEX IF NOT EXISTS atlog_date_idx       ON attendance_logs (date DESC);
CREATE INDEX IF NOT EXISTS face_desc_client_idx ON face_descriptors (client_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS notif_user_idx       ON notifications (user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS actlog_date_idx      ON activity_log (created_at DESC);

-- ─── 8. updated_at trigger function ─────────────────────────
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
  FOR t IN SELECT unnest(ARRAY['users','trainers','clients','system_settings','leave_requests'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at'
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

-- ─── Done ────────────────────────────────────────────────────
-- This migration is idempotent. Safe to re-run on v3 or v4 databases.
SELECT 'Migration 001 complete' AS status;
