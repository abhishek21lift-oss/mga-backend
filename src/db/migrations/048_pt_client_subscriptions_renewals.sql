-- 048_pt_client_subscriptions_renewals.sql
-- Creates two tables referenced throughout the codebase (pt-os.routes.js, import.js, ai.js)
-- but previously missing migrations — fixing schema drift.

-- pt_client_subscriptions: canonical history of every PT package term per client.
-- Written to by the PT onboarding/renewal flow and bulk import.
CREATE TABLE IF NOT EXISTS pt_client_subscriptions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT, matching pt_clients.id (migration 017 declares it
  -- "TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT"). Declared INTEGER
  -- here, which cannot reference a TEXT key, so Postgres rejected the foreign
  -- key and a fresh database stopped on this migration.
  client_id        TEXT        NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  plan_name        VARCHAR(200),
  start_date       DATE,
  end_date         DATE,
  duration_months  NUMERIC(5,1),
  selling_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid      NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  trainer_name     VARCHAR(200),
  status           VARCHAR(20)  NOT NULL DEFAULT 'active',
  source           VARCHAR(50)  NOT NULL DEFAULT 'manual',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_client_subs_client   ON pt_client_subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_pt_client_subs_status   ON pt_client_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_pt_client_subs_end_date ON pt_client_subscriptions(end_date);

-- pt_client_renewals: audit log of every renewal transaction.
-- Written by the renewal endpoint; queried for renewal history and business analytics.
CREATE TABLE IF NOT EXISTS pt_client_renewals (
  id               SERIAL      PRIMARY KEY,
  -- TEXT, matching pt_clients.id (migration 017 declares it
  -- "TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT"). Declared INTEGER
  -- here, which cannot reference a TEXT key, so Postgres rejected the foreign
  -- key and a fresh database stopped on this migration.
  client_id        TEXT        NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
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
  renewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_client_renewals_client     ON pt_client_renewals(client_id);
CREATE INDEX IF NOT EXISTS idx_pt_client_renewals_renewed_at ON pt_client_renewals(renewed_at);
