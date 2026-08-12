-- 003_plans_table.sql
-- Creates the plans table (was missing from schema.sql entirely).
-- Also adds extra columns that the frontend sends but the old INSERT ignored.

CREATE TABLE IF NOT EXISTS plans (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  kind              TEXT        NOT NULL DEFAULT 'Membership'
                                CHECK (kind IN ('Membership','PT')),
  name              TEXT        NOT NULL,
  description       TEXT,
  duration          TEXT        NOT NULL DEFAULT 'Monthly'
                                CHECK (duration IN ('Monthly','Quarterly','Half Yearly','Yearly')),
  base_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  final_amount      NUMERIC(10,2) NOT NULL,
  joining_fee       NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_pct           NUMERIC(5,2)  NOT NULL DEFAULT 18,
  sessions_per_week INT,
  features          JSONB       NOT NULL DEFAULT '[]',
  popular           BOOLEAN     NOT NULL DEFAULT FALSE,
  color             TEXT        NOT NULL DEFAULT 'violet',
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns to existing plans table (idempotent — safe to re-run)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS joining_fee   NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tax_pct       NUMERIC(5,2)  NOT NULL DEFAULT 18;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS color         TEXT          NOT NULL DEFAULT 'violet';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;

-- Ensure features column is JSONB (upgrade from TEXT if needed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'features' AND data_type = 'text'
  ) THEN
    ALTER TABLE plans ALTER COLUMN features TYPE JSONB USING features::jsonb;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS plans_kind_idx      ON plans (kind);
CREATE INDEX IF NOT EXISTS plans_active_idx    ON plans (is_active);
CREATE INDEX IF NOT EXISTS plans_duration_idx  ON plans (duration);
