-- 050_fix_pt_clients_missing_cols.sql
-- 1. Adds fitness-profile columns that the onboarding wizard collects but pt_clients
--    never had (goal, height, body_fat, health_conditions, injuries, frequency).
-- 2. Rebuilds pt_client_subscriptions / pt_client_renewals with TEXT client_id
--    so the FK references pt_clients.id (TEXT) correctly.
--    Migration 048 accidentally used INTEGER for client_id, causing FK type mismatch.

-- ── Fitness profile columns on pt_clients ──────────────────────────────────
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS goal              TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS height            NUMERIC(5,2);
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS body_fat          NUMERIC(5,2);
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS health_conditions TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS injuries          TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS frequency         TEXT;

-- ── Rebuild pt_client_subscriptions with correct FK type ───────────────────
-- Drop and recreate only if client_id column type is wrong (integer).
-- If the table already has TEXT client_id (e.g. env that fixed 048), this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name   = 'pt_client_subscriptions'
      AND column_name  = 'client_id'
      AND data_type    = 'integer'
  ) THEN
    DROP TABLE IF EXISTS pt_client_subscriptions CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pt_client_subscriptions (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        TEXT         NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  plan_name        VARCHAR(200),
  start_date       DATE,
  end_date         DATE,
  duration_months  NUMERIC(5,1),
  selling_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid      NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  trainer_name     VARCHAR(200),
  status           VARCHAR(20)   NOT NULL DEFAULT 'active',
  source           VARCHAR(50)   NOT NULL DEFAULT 'manual',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_client_subs_client   ON pt_client_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_pt_client_subs_status   ON pt_client_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_pt_client_subs_end_date ON pt_client_subscriptions(end_date);

-- ── Rebuild pt_client_renewals with correct FK type ────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name   = 'pt_client_renewals'
      AND column_name  = 'client_id'
      AND data_type    = 'integer'
  ) THEN
    DROP TABLE IF EXISTS pt_client_renewals CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pt_client_renewals (
  id               SERIAL       PRIMARY KEY,
  client_id        TEXT         NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  client_name      VARCHAR(200),
  trainer_name     VARCHAR(200),
  old_package      VARCHAR(200),
  new_package      VARCHAR(200),
  old_end_date     DATE,
  new_start_date   DATE,
  new_end_date     DATE,
  duration_months  NUMERIC(5,1),
  base_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  renewed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_client_renewals_client     ON pt_client_renewals(client_id);
CREATE INDEX IF NOT EXISTS idx_pt_client_renewals_renewed_at ON pt_client_renewals(renewed_at);
