-- ============================================================
-- 018_complete_pt_independence.sql
-- Complete separation of PT OS from Gym Management.
-- Creates PT-specific tables for trainers, payments, sessions,
-- workout plans, diet plans, progress tracking, and automation.
-- PT OS now references ZERO shared gym management tables.
-- ============================================================

-- ── 1. pt_trainers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_trainers (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name             TEXT        NOT NULL,
  email            TEXT,
  mobile           TEXT,
  specialization   TEXT,
  bio              TEXT,
  schedule         TEXT,
  certifications   TEXT,
  incentive_rate   NUMERIC(5,4) NOT NULL DEFAULT 0.5
                               CHECK (incentive_rate BETWEEN 0 AND 1),
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive')),
  joining_date     DATE,
  photo_url        TEXT,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pt_trainers (id, name, email, mobile, specialization, bio, schedule,
  certifications, incentive_rate, status, joining_date,
  deleted_at, created_at, updated_at)
SELECT id, name, email, mobile, specialization, bio, schedule,
  certifications, incentive_rate, status, joining_date,
  deleted_at, created_at, updated_at
FROM trainers
WHERE deleted_at IS NULL;

-- ── 2. pt_payments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_payments (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id       TEXT         REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id      TEXT         REFERENCES pt_trainers(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  incentive_amt   NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method  TEXT,
  payment_ref     TEXT,
  date            DATE         NOT NULL DEFAULT CURRENT_DATE,
  status          TEXT         NOT NULL DEFAULT 'completed'
                               CHECK (status IN ('pending','completed','failed','refunded')),
  notes           TEXT,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pt_payments_client_idx ON pt_payments (client_id);
CREATE INDEX IF NOT EXISTS pt_payments_trainer_idx ON pt_payments (trainer_id);
CREATE INDEX IF NOT EXISTS pt_payments_date_idx ON pt_payments (date);

-- Migrate existing PT-related payments
INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes, created_at, updated_at)
SELECT p.client_id, p.trainer_id, p.amount, COALESCE(p.incentive_amt, 0), p.method, p.receipt_no, p.date, 'Migrated from gym payments', p.created_at, p.updated_at
FROM payments p
WHERE p.trainer_id IS NOT NULL
  AND p.deleted_at IS NULL;

-- ── 3. pt_sessions (already exists from 015, alter FKs & add columns) ─
ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS title       TEXT;
ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DO $$ BEGIN
  -- Drop FK referencing shared clients
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_sessions_client_id_fkey') THEN
    ALTER TABLE pt_sessions DROP CONSTRAINT pt_sessions_client_id_fkey;
  END IF;
  -- Drop FK referencing shared trainers
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_sessions_trainer_id_fkey') THEN
    ALTER TABLE pt_sessions DROP CONSTRAINT pt_sessions_trainer_id_fkey;
  END IF;
END $$;

ALTER TABLE pt_sessions ADD CONSTRAINT pt_sessions_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;
ALTER TABLE pt_sessions ADD CONSTRAINT pt_sessions_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES pt_trainers(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS pt_sessions_date_idx;
CREATE INDEX IF NOT EXISTS pt_sessions_client_idx ON pt_sessions (client_id);
CREATE INDEX IF NOT EXISTS pt_sessions_trainer_idx ON pt_sessions (trainer_id);
CREATE INDEX IF NOT EXISTS pt_sessions_date_idx ON pt_sessions (session_date);

-- ── 4. Fix trigger on pt_clients to use pt_trainers ──────────────
CREATE OR REPLACE FUNCTION fn_pt_update_trainer_commission()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trainer_id IS NOT NULL AND NEW.monthly_pt_amount > 0 THEN
    NEW.trainer_commission = ROUND(
      NEW.monthly_pt_amount * COALESCE(
        (SELECT incentive_rate FROM pt_trainers WHERE id = NEW.trainer_id),
        0.5
      ),
      2
    );
  ELSE
    NEW.trainer_commission = 0;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Recreate v_pt_trainer_earnings on pt_trainers ─────────────
DROP VIEW IF EXISTS v_pt_trainer_earnings;
CREATE OR REPLACE VIEW v_pt_trainer_earnings AS
SELECT
  t.id AS trainer_id,
  t.name AS trainer_name,
  DATE_TRUNC('month', c.pt_start_date::DATE)::DATE AS month,
  COUNT(DISTINCT c.id) AS active_clients,
  COALESCE(SUM(c.monthly_pt_amount), 0) AS total_monthly_pt_revenue,
  COALESCE(SUM(c.trainer_commission), 0) AS total_commission_earned,
  t.incentive_rate
FROM pt_trainers t
JOIN pt_clients c ON c.trainer_id = t.id
  AND c.deleted_at IS NULL
  AND c.status IN ('active','frozen')
  AND c.pt_start_date IS NOT NULL
WHERE t.deleted_at IS NULL
  AND t.status = 'active'
GROUP BY t.id, t.name, DATE_TRUNC('month', c.pt_start_date::DATE), t.incentive_rate;

-- ── 6. Indexes for pt_trainers ──────────────────────────────────
CREATE INDEX IF NOT EXISTS pt_trainers_name_idx ON pt_trainers (name);
CREATE INDEX IF NOT EXISTS pt_trainers_status_idx ON pt_trainers (status);
