-- ============================================================
-- 033_schema_fixes.sql
-- Addresses schema issues found during system audit:
--   1. Add missing indexes on high-frequency lookup columns
--   2. Rename unnumbered staff.sql tables to use TEXT PKs for
--      consistency (all other tables use TEXT DEFAULT gen_random_uuid()::TEXT)
--   3. Convert pt_clients date columns from TEXT to DATE
-- ============================================================

-- ── 1. Missing indexes ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS system_settings_key_idx   ON system_settings (key);
CREATE INDEX IF NOT EXISTS feature_flags_key_idx     ON feature_flags (key);
CREATE INDEX IF NOT EXISTS pt_clients_pt_end_date_idx ON pt_clients (pt_end_date);
CREATE INDEX IF NOT EXISTS attendance_logs_method_idx ON attendance_logs (method);
CREATE INDEX IF NOT EXISTS attendance_logs_date_idx   ON attendance_logs (date);

-- ── 2. staff table: UUID → TEXT primary key ───────────────────
-- Recreate staff and staff_targets with TEXT PKs to match the
-- rest of the schema. Safe to run multiple times (IF NOT EXISTS guards).

DO $$ BEGIN

  -- Only migrate if the PK is still UUID (idempotency check)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'staff'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN

    -- Create new tables with TEXT PKs
    CREATE TABLE IF NOT EXISTS staff_new (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      name        TEXT NOT NULL,
      email       TEXT,
      phone       TEXT,
      role        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff_targets_new (
      id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      staff_id            TEXT NOT NULL REFERENCES staff_new(id) ON DELETE CASCADE,
      month               TEXT NOT NULL,
      target_revenue      NUMERIC(12,2) DEFAULT 0,
      target_clients      INT DEFAULT 0,
      target_sessions     INT DEFAULT 0,
      achieved_revenue    NUMERIC(12,2) DEFAULT 0,
      achieved_clients    INT DEFAULT 0,
      achieved_sessions   INT DEFAULT 0,
      UNIQUE (staff_id, month)
    );

    -- Migrate data (cast UUID → TEXT)
    INSERT INTO staff_new (id, name, email, phone, role, status, created_at)
    SELECT id::TEXT, name, email, phone, role, status, created_at
    FROM staff
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO staff_targets_new (id, staff_id, month, target_revenue, target_clients,
      target_sessions, achieved_revenue, achieved_clients, achieved_sessions)
    SELECT id::TEXT, staff_id::TEXT, month, target_revenue, target_clients,
      target_sessions, achieved_revenue, achieved_clients, achieved_sessions
    FROM staff_targets
    ON CONFLICT DO NOTHING;

    -- Drop old tables and rename
    DROP TABLE IF EXISTS staff_targets;
    DROP TABLE IF EXISTS staff;
    ALTER TABLE staff_new RENAME TO staff;
    ALTER TABLE staff_targets_new RENAME TO staff_targets;

  END IF;

END $$;

-- ── 3. pt_clients date columns: TEXT → DATE ───────────────────
-- Drop views that reference these columns first; recreate after.
-- Only runs when columns are still TEXT (idempotent).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pt_clients'
      AND column_name = 'dob'
      AND data_type = 'text'
  ) THEN

    DROP VIEW IF EXISTS v_pt_trainer_earnings;
    DROP VIEW IF EXISTS v_pt_active_clients;
    DROP VIEW IF EXISTS v_pt_balance_sheet;

    ALTER TABLE pt_clients
      ALTER COLUMN dob           TYPE DATE USING NULLIF(TRIM(dob), '')::DATE,
      ALTER COLUMN joining_date  TYPE DATE USING NULLIF(TRIM(joining_date), '')::DATE,
      ALTER COLUMN pt_start_date TYPE DATE USING NULLIF(TRIM(pt_start_date), '')::DATE,
      ALTER COLUMN pt_end_date   TYPE DATE USING NULLIF(TRIM(pt_end_date), '')::DATE;

  END IF;
END $$;

-- Recreate views (DROP was conditional above; these are safe to run always
-- because CREATE OR REPLACE handles the "already exists" case, and the
-- columns are DATE in all paths — either just converted or already DATE).
CREATE OR REPLACE VIEW v_pt_active_clients AS
SELECT * FROM pt_clients
WHERE deleted_at IS NULL
  AND status IN ('active', 'frozen')
  AND pt_start_date IS NOT NULL;

CREATE OR REPLACE VIEW v_pt_balance_sheet AS
SELECT * FROM pt_clients
WHERE deleted_at IS NULL
  AND balance_amount > 0
ORDER BY balance_amount DESC;

CREATE OR REPLACE VIEW v_pt_trainer_earnings AS
SELECT
  t.id         AS trainer_id,
  t.name       AS trainer_name,
  DATE_TRUNC('month', c.pt_start_date)::DATE AS month,
  COUNT(DISTINCT c.id)                        AS active_clients,
  COALESCE(SUM(c.monthly_pt_amount), 0)       AS total_monthly_pt_revenue,
  COALESCE(SUM(c.trainer_commission), 0)      AS total_commission_earned,
  t.incentive_rate
FROM pt_trainers t
JOIN pt_clients c ON c.trainer_id = t.id
  AND c.deleted_at IS NULL
  AND c.status IN ('active', 'frozen')
  AND c.pt_start_date IS NOT NULL
WHERE t.deleted_at IS NULL
  AND t.status = 'active'
GROUP BY t.id, t.name, DATE_TRUNC('month', c.pt_start_date), t.incentive_rate;
