-- 099_subscription_foundation.sql
-- SaaS subscription system for MY PT STUDIO. Each tenant (organizations row) is a
-- studio that subscribes. This lays the foundation: plan catalogue, per-studio
-- subscription state, founder club, payments, invoices, and a billing audit log.
--
-- Model (admin-activated billing): studios pay out-of-band; the super admin
-- records the payment in the command centre, which activates the subscription.
-- New studios get a 7-day trial automatically; when it lapses without payment the
-- studio is frozen (access suspended, data preserved). Enforcement is lazy — the
-- auth layer compares trial_ends_at / current_period_end against now() on each
-- request — so no cron is required for freezing (reminders use a worker).
--
-- Grandfathering: every EXISTING studio is set to 'active' with no expiry and no
-- client limit, so nothing that is already live gets frozen by this rollout. Only
-- studios created AFTER this migration enter the trial → paid lifecycle.
-- Idempotent throughout.

-- ── Plan catalogue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  code             TEXT PRIMARY KEY,               -- 'starter' | 'growth' | 'professional' | 'elite'
  name             TEXT NOT NULL,
  price_inr        INTEGER NOT NULL,               -- regular price in whole rupees
  launch_price_inr INTEGER,                        -- launch-offer price (NULL if none)
  duration_months  INTEGER NOT NULL,
  client_limit     INTEGER,                        -- NULL = unlimited
  best_for         TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (code, name, price_inr, launch_price_inr, duration_months, client_limit, best_for, sort_order)
VALUES
  ('starter',      'Starter',      1499, NULL, 1,  20,   'New Personal Trainers',  1),
  ('growth',       'Growth',       3999, NULL, 3,  25,   'Growing Trainers',       2),
  ('professional', 'Professional', 6999, NULL, 6,  30,   'Established Trainers',    3),
  ('elite',        'Elite',        9999, 7999, 12, NULL, 'Professional Coaches',   4)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      price_inr = EXCLUDED.price_inr,
      launch_price_inr = EXCLUDED.launch_price_inr,
      duration_months = EXCLUDED.duration_months,
      client_limit = EXCLUDED.client_limit,
      best_for = EXCLUDED.best_for,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();

-- ── Per-studio subscription state (denormalised onto organizations for fast,
-- join-free enforcement in the auth hot path) ────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status   TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at         TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_period_start  TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_period_end    TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_code             TEXT REFERENCES subscription_plans(code);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_limit          INTEGER;      -- NULL = unlimited
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_founder            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS founder_number        INTEGER;      -- 1..50 once granted
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS locked_price_inr      INTEGER;      -- founders keep this price on renewal
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancelled_at          TIMESTAMPTZ;

-- subscription_status lifecycle: trial | active | expired | frozen | cancelled
-- (the separate organizations.status column stays the super-admin hard on/off:
--  'suspended' there blocks a studio regardless of subscription state).

-- Grandfather existing studios: active, unlimited, no expiry. Applied only to
-- rows that predate this migration (created before now()).
UPDATE organizations
   SET subscription_status = 'active',
       trial_ends_at = NULL,
       current_period_end = NULL,
       client_limit = NULL
 WHERE created_at < now();

-- ── Founder club (permanent record; first 50 paying studios) ──────────────────
CREATE TABLE IF NOT EXISTS founder_members (
  organization_id  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  founder_number   INTEGER NOT NULL UNIQUE,        -- 1..50
  plan_code        TEXT REFERENCES subscription_plans(code),
  locked_price_inr INTEGER NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Payments (recorded by the super admin when a studio pays) ─────────────────
CREATE TABLE IF NOT EXISTS subscription_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code        TEXT REFERENCES subscription_plans(code),
  amount_inr       INTEGER NOT NULL,
  method           TEXT,                            -- 'upi' | 'bank' | 'cash' | 'razorpay' | 'comp' ...
  reference        TEXT,                            -- UTR / txn id / note
  status           TEXT NOT NULL DEFAULT 'paid',    -- 'paid' | 'refunded'
  period_start     TIMESTAMPTZ,
  period_end       TIMESTAMPTZ,
  recorded_by      UUID,                            -- super-admin user id
  recorded_by_name TEXT,
  refunded_at      TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_payments_org ON subscription_payments(organization_id, created_at DESC);

-- ── Invoices (one per payment) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id       UUID REFERENCES subscription_payments(id) ON DELETE SET NULL,
  invoice_number   TEXT NOT NULL UNIQUE,
  plan_code        TEXT REFERENCES subscription_plans(code),
  amount_inr       INTEGER NOT NULL,
  period_start     TIMESTAMPTZ,
  period_end       TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'paid',    -- 'paid' | 'refunded'
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_invoices_org ON subscription_invoices(organization_id, issued_at DESC);

-- ── Billing audit log (state changes, reminders, refunds, founder grants) ─────
CREATE TABLE IF NOT EXISTS subscription_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  event            TEXT NOT NULL,                   -- trial_started | activated | frozen | reactivated | plan_changed | founder_granted | reminder_sent | refunded | cancelled
  data             JSONB,
  actor_id         UUID,
  actor_name       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_events_org ON subscription_events(organization_id, created_at DESC);
