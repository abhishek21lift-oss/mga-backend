-- ============================================================
-- 619 ERP — Migration 002: Add missing columns for client actions
-- Safe to re-run (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ─── Freeze columns on clients ───────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS freeze_from    DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS freeze_until   DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS freeze_reason  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_frozen      BOOLEAN DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS combo_plan     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pt_sessions_total INT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS next_followup_date DATE;

-- ─── Payments soft-delete (if not already added by migration 001) ─
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ─── action_type on renewals ─────────────────────────────────
ALTER TABLE renewals ADD COLUMN IF NOT EXISTS action_type TEXT DEFAULT 'renewal';

-- ─── membership_actions table ────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_actions (
  id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id      TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_name    TEXT,
  trainer_id     TEXT        REFERENCES trainers(id) ON DELETE SET NULL,
  action_type    TEXT        NOT NULL,
  old_value      JSONB,
  new_value      JSONB,
  amount         NUMERIC(12,2) DEFAULT 0,
  payment_method TEXT,
  notes          TEXT,
  performed_by   TEXT,
  action_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mactions_client_idx ON membership_actions (client_id);
CREATE INDEX IF NOT EXISTS mactions_date_idx   ON membership_actions (action_date DESC);

-- ─── trials table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trials (
  id           TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id    TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  client_name  TEXT,
  trainer_id   TEXT    REFERENCES trainers(id) ON DELETE SET NULL,
  trainer_name TEXT,
  trial_date   DATE    NOT NULL,
  time_slot    TEXT,
  focus_area   TEXT,
  notes        TEXT,
  status       TEXT    NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled','completed','no_show','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trials_client_idx ON trials (client_id);
CREATE INDEX IF NOT EXISTS trials_date_idx   ON trials (trial_date);

-- ─── face_checkin_logs table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS face_checkin_logs (
  id          TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id   TEXT    REFERENCES clients(id) ON DELETE SET NULL,
  status      TEXT    NOT NULL DEFAULT 'success'
              CHECK (status IN ('success','failed','expired','denied','unknown')),
  distance    FLOAT8,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fcl_client_idx ON face_checkin_logs (client_id);
CREATE INDEX IF NOT EXISTS fcl_date_idx   ON face_checkin_logs (created_at DESC);

-- ─── plans table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  kind             TEXT        NOT NULL DEFAULT 'Membership'
                   CHECK (kind IN ('Membership','PT','AddOn','Diet','Combo')),
  name             TEXT        NOT NULL,
  duration         TEXT        NOT NULL DEFAULT 'Monthly',
  base_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_amount     NUMERIC(12,2) NOT NULL,
  sessions_per_week INT,
  features         JSONB       DEFAULT '[]',
  popular          BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plans_kind_idx ON plans (kind) WHERE is_active;
