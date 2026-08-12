-- ============================================================
-- 017_pt_clients_separation.sql
-- Complete separation of PT OS data from gym management.
-- Creates pt_clients table, migrates data, updates FKs & views.
-- ============================================================
--
-- ORDERING DEPENDENCY NOTICE
-- ------------------------------------------------------------------
-- This migration (017) MUST run before 018_complete_pt_independence.sql.
--
-- Dependency detail:
--   The trigger function fn_pt_update_trainer_commission() defined
--   below (lines ~66-89) queries the `trainers` table (shared gym
--   management table) to look up `incentive_rate`.  This is a
--   KNOWN TEMPORARY REFERENCE to the old `trainers` table.
--
--   Migration 018 replaces this function with an updated version
--   that queries `pt_trainers` instead, completing the separation.
--   Until 018 runs, the trigger will fall back to the default 0.5
--   rate for any trainer whose id does not exist in `trainers`.
--
--   Do NOT run these two migrations out of order or independently;
--   always apply 017 → 018 as a pair.
-- ------------------------------------------------------------------

-- ── Create pt_clients table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pt_clients (
  id                TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT,
  name              TEXT         NOT NULL,
  email             TEXT,
  mobile            TEXT,
  gender            TEXT,
  dob               TEXT,
  address           TEXT,
  photo_url         TEXT,
  trainer_id        TEXT,
  trainer_name      TEXT,
  package_type      TEXT,
  base_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  joining_date      TEXT,
  pt_start_date     TEXT,
  pt_end_date       TEXT,
  duration_months   INT,
  monthly_pt_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  trainer_commission NUMERIC(12,2) NOT NULL DEFAULT 0,
  weight            NUMERIC(12,2),
  notes             TEXT,
  status            TEXT         NOT NULL DEFAULT 'active',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Migrate existing PT clients from the shared clients table
INSERT INTO pt_clients (id, client_id, name, email, mobile, gender, dob, address, photo_url,
  trainer_id, trainer_name, package_type, base_amount, discount, final_amount, paid_amount, balance_amount,
  joining_date, pt_start_date, pt_end_date, duration_months, monthly_pt_amount, trainer_commission,
  weight, notes, status, deleted_at, created_at, updated_at)
SELECT id, client_id, name, email, mobile, gender, dob, address, photo_url,
  trainer_id, trainer_name, package_type, base_amount, discount, final_amount, paid_amount, balance_amount,
  joining_date, pt_start_date, pt_end_date, duration_months, monthly_pt_amount, trainer_commission,
  weight, notes, status, deleted_at, created_at, updated_at
FROM clients
WHERE pt_start_date IS NOT NULL OR trainer_id IS NOT NULL;

-- ── Drop old PT views + trigger that depend on clients.duration_months ──
DROP VIEW IF EXISTS v_pt_active_clients;
DROP VIEW IF EXISTS v_pt_balance_sheet;
DROP VIEW IF EXISTS v_pt_trainer_earnings;
DROP TRIGGER IF EXISTS trg_clients_trainer_commission ON clients;
DROP FUNCTION IF EXISTS fn_update_trainer_commission();

-- ── Remove PT columns from shared clients table ────────────────────
ALTER TABLE clients
  DROP COLUMN IF EXISTS duration_months,
  DROP COLUMN IF EXISTS monthly_pt_amount,
  DROP COLUMN IF EXISTS trainer_commission;

-- ── Create trigger on pt_clients ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_pt_update_trainer_commission()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trainer_id IS NOT NULL AND NEW.monthly_pt_amount > 0 THEN
    NEW.trainer_commission = ROUND(
      NEW.monthly_pt_amount * COALESCE(
        (SELECT incentive_rate FROM trainers WHERE id = NEW.trainer_id),
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

DROP TRIGGER IF EXISTS trg_pt_clients_trainer_commission ON pt_clients;
CREATE TRIGGER trg_pt_clients_trainer_commission
  BEFORE INSERT OR UPDATE OF monthly_pt_amount, trainer_id
  ON pt_clients
  FOR EACH ROW
  EXECUTE FUNCTION fn_pt_update_trainer_commission();

-- ── Update pt_commissions FK to reference pt_clients ───────────────
ALTER TABLE pt_commissions DROP CONSTRAINT IF EXISTS pt_commissions_client_id_fkey;
ALTER TABLE pt_commissions ADD CONSTRAINT pt_commissions_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

-- ── Recreate views on pt_clients ──────────────────────────────────
CREATE OR REPLACE VIEW v_pt_active_clients AS
SELECT * FROM pt_clients
WHERE deleted_at IS NULL
  AND status IN ('active','frozen')
  AND pt_start_date IS NOT NULL;

CREATE OR REPLACE VIEW v_pt_balance_sheet AS
SELECT * FROM pt_clients
WHERE deleted_at IS NULL
  AND balance_amount > 0
ORDER BY balance_amount DESC;

CREATE OR REPLACE VIEW v_pt_trainer_earnings AS
SELECT
  t.id AS trainer_id,
  t.name AS trainer_name,
  DATE_TRUNC('month', c.pt_start_date::DATE)::DATE AS month,
  COUNT(DISTINCT c.id) AS active_clients,
  COALESCE(SUM(c.monthly_pt_amount), 0) AS total_monthly_pt_revenue,
  COALESCE(SUM(c.trainer_commission), 0) AS total_commission_earned,
  t.incentive_rate
FROM trainers t
JOIN pt_clients c ON c.trainer_id = t.id
  AND c.deleted_at IS NULL
  AND c.status IN ('active','frozen')
  AND c.pt_start_date IS NOT NULL
WHERE t.deleted_at IS NULL
  AND t.status = 'active'
GROUP BY t.id, t.name, DATE_TRUNC('month', c.pt_start_date::DATE), t.incentive_rate;

-- ── Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS pt_clients_trainer_idx ON pt_clients (trainer_id);
CREATE INDEX IF NOT EXISTS pt_clients_status_idx ON pt_clients (status);
CREATE INDEX IF NOT EXISTS pt_clients_pt_start_idx ON pt_clients (pt_start_date);
