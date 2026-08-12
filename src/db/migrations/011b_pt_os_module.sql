-- ============================================================
-- 011_pt_os_module.sql
-- PT OS â€” Personal Training Operating System
-- Adds: pt-specific columns, pt_plans, pt_commissions, pt_payouts, views
-- ============================================================

-- â”€â”€â”€ Extend clients with PT-specific columns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS duration_months    INT,
  ADD COLUMN IF NOT EXISTS monthly_pt_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trainer_commission NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Populate duration_months from existing dates
UPDATE clients
SET duration_months = COALESCE(
  (EXTRACT(YEAR FROM pt_end_date) - EXTRACT(YEAR FROM pt_start_date)) * 12
  + EXTRACT(MONTH FROM pt_end_date) - EXTRACT(MONTH FROM pt_start_date),
  0
)
WHERE pt_start_date IS NOT NULL AND pt_end_date IS NOT NULL
  AND (duration_months IS NULL OR duration_months = 0);


-- â”€â”€â”€ PT PLANS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS pt_plans (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name            TEXT         NOT NULL UNIQUE,
  duration_months INT          NOT NULL CHECK (duration_months > 0),
  base_amount     NUMERIC(12,2) NOT NULL CHECK (base_amount >= 0),
  description     TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO pt_plans (name, duration_months, base_amount, description) VALUES
  ('Basic PT',       1,  3000,  '1 month personal training'),
  ('Standard PT',    3,  8000,  '3 month PT package'),
  ('Premium PT',     6,  15000, '6 month PT package'),
  ('Elite PT',       12, 25000, '12 month PT package'),
  ('Trial PT',       1,  1500,  'Trial month personal training')
ON CONFLICT (name) DO NOTHING;


-- â”€â”€â”€ PT COMMISSIONS (monthly accruals) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS pt_commissions (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trainer_id      TEXT         NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  trainer_name    TEXT,
  client_id       TEXT         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_name     TEXT,
  month           DATE         NOT NULL,  -- first day of month: 2026-05-01
  commission_amt  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (commission_amt >= 0),
  incentive_rate  NUMERIC(5,4) NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','paid','cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (trainer_id, client_id, month)
);

CREATE INDEX IF NOT EXISTS pt_comm_trainer_idx ON pt_commissions (trainer_id, month);
CREATE INDEX IF NOT EXISTS pt_comm_month_idx   ON pt_commissions (month);
CREATE INDEX IF NOT EXISTS pt_comm_status_idx  ON pt_commissions (status);


-- â”€â”€â”€ PT PAYOUTS (batch payments to trainers) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS pt_payouts (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trainer_id      TEXT         NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  trainer_name    TEXT,
  month           DATE         NOT NULL,
  total_commission NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions      NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method  TEXT,
  payment_ref     TEXT,
  paid_at         TIMESTAMPTZ,
  status          TEXT         NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','paid','cancelled')),
  notes           TEXT,
  processed_by    TEXT         REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (trainer_id, month)
);

CREATE INDEX IF NOT EXISTS pt_payouts_trainer_idx ON pt_payouts (trainer_id, month);
CREATE INDEX IF NOT EXISTS pt_payouts_status_idx  ON pt_payouts (status);


-- â”€â”€â”€ VIEW: Active clients per trainer (like Excel sheets) â”€â”€â”€â”€â”€
CREATE OR REPLACE VIEW v_pt_active_clients AS
SELECT
  c.id,
  c.client_id,
  c.name,
  c.gender,
  c.mobile,
  c.trainer_id,
  c.trainer_name,
  c.package_type,
  c.base_amount,
  c.discount,
  c.final_amount,
  c.paid_amount,
  c.balance_amount,
  c.joining_date,
  c.duration_months,
  c.pt_start_date,
  c.pt_end_date,
  CASE
    WHEN c.pt_end_date IS NULL THEN NULL
    ELSE (c.pt_end_date - CURRENT_DATE)
  END AS days_left,
  c.status,
  c.monthly_pt_amount,
  c.trainer_commission
FROM clients c
WHERE c.deleted_at IS NULL
  AND c.status IN ('active','frozen')
  AND c.pt_start_date IS NOT NULL;


-- â”€â”€â”€ VIEW: Balance sheet (clients with pending dues) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE OR REPLACE VIEW v_pt_balance_sheet AS
SELECT
  c.id,
  c.client_id,
  c.name,
  c.mobile,
  c.trainer_name,
  c.package_type,
  c.final_amount,
  c.paid_amount,
  c.balance_amount,
  c.pt_end_date,
  (c.pt_end_date - CURRENT_DATE) AS days_left,
  c.status,
  CASE
    WHEN c.balance_amount > 0 AND c.pt_end_date < CURRENT_DATE THEN 'OVERDUE'
    WHEN c.balance_amount > 0 THEN 'DUE'
    ELSE 'CLEAR'
  END AS due_status,
  c.monthly_pt_amount,
  c.trainer_commission,
  c.updated_at
FROM clients c
WHERE c.deleted_at IS NULL
  AND c.balance_amount > 0
ORDER BY c.balance_amount DESC;


-- â”€â”€â”€ VIEW: Trainer monthly earnings summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE OR REPLACE VIEW v_pt_trainer_earnings AS
SELECT
  t.id AS trainer_id,
  t.name AS trainer_name,
  DATE_TRUNC('month', c.pt_start_date)::DATE AS month,
  COUNT(DISTINCT c.id) AS active_clients,
  COALESCE(SUM(c.monthly_pt_amount), 0) AS total_monthly_pt_revenue,
  COALESCE(SUM(c.trainer_commission), 0) AS total_commission_earned,
  t.incentive_rate
FROM trainers t
JOIN clients c ON c.trainer_id = t.id
  AND c.deleted_at IS NULL
  AND c.status IN ('active','frozen')
  AND c.pt_start_date IS NOT NULL
WHERE t.deleted_at IS NULL
  AND t.status = 'active'
GROUP BY t.id, t.name, DATE_TRUNC('month', c.pt_start_date), t.incentive_rate;


-- â”€â”€â”€ TRIGGER: auto-update trainer_commission when monthly_pt_amount changes â”€â”€
CREATE OR REPLACE FUNCTION fn_update_trainer_commission()
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

DROP TRIGGER IF EXISTS trg_clients_trainer_commission ON clients;
CREATE TRIGGER trg_clients_trainer_commission
  BEFORE INSERT OR UPDATE OF monthly_pt_amount, trainer_id
  ON clients
  FOR EACH ROW
  EXECUTE FUNCTION fn_update_trainer_commission();
