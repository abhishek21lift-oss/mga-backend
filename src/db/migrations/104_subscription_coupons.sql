-- 104_subscription_coupons.sql
-- Discount coupons for subscription activation / renewal / upgrade.
--
-- Two tables plus two columns on subscription_payments:
--   subscription_coupons             — the catalogue an operator manages
--   subscription_coupon_redemptions  — an immutable ledger of every use
--   subscription_payments.coupon_code / discount_inr — what was actually applied
--
-- The redemption ledger is deliberately separate from a counter on the coupon.
-- A bare counter cannot answer "who used this and when", cannot enforce a
-- per-studio limit, and cannot be reconciled against payments if something goes
-- wrong. times_redeemed is derived from the ledger, never trusted on its own.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS subscription_coupons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored uppercase; lookups uppercase the input so codes are case-insensitive
  -- to the person typing them but exact in the database.
  code             TEXT NOT NULL UNIQUE,
  description      TEXT,
  -- 'percent' → value is 1..100. 'fixed' → value is whole rupees off.
  discount_type    TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value   INTEGER NOT NULL CHECK (discount_value > 0),
  -- Caps a percentage discount in absolute rupees. NULL = uncapped.
  max_discount_inr INTEGER CHECK (max_discount_inr IS NULL OR max_discount_inr > 0),
  -- Order must reach this before the coupon applies. NULL = no minimum.
  min_amount_inr   INTEGER CHECK (min_amount_inr IS NULL OR min_amount_inr >= 0),
  -- NULL = every plan. Otherwise only these plan codes.
  applies_to_plans TEXT[],
  -- NULL = unlimited total uses.
  max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  -- How many times ONE studio may use it. Default 1 stops a single studio
  -- draining a promotion by renewing repeatedly.
  max_per_org      INTEGER NOT NULL DEFAULT 1 CHECK (max_per_org > 0),
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  -- users.id is TEXT in this schema, not UUID — the FK must match or it cannot
  -- be created at all.
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A percentage over 100 would invert the charge.
  CONSTRAINT coupon_percent_range CHECK (
    discount_type <> 'percent' OR discount_value BETWEEN 1 AND 100
  )
);

CREATE TABLE IF NOT EXISTS subscription_coupon_redemptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id        UUID NOT NULL REFERENCES subscription_coupons(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The payment this discount was applied to. Nullable so a redemption survives
  -- a payment being hard-deleted, keeping the audit trail intact.
  payment_id       UUID REFERENCES subscription_payments(id) ON DELETE SET NULL,
  plan_code        TEXT REFERENCES subscription_plans(code),
  -- What the studio would have paid, what came off, what they actually paid.
  gross_amount_inr INTEGER NOT NULL,
  discount_inr     INTEGER NOT NULL,
  net_amount_inr   INTEGER NOT NULL,
  redeemed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON subscription_coupon_redemptions (coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_org    ON subscription_coupon_redemptions (organization_id);
-- The per-studio limit check filters on both columns together.
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_org
  ON subscription_coupon_redemptions (coupon_id, organization_id);
-- Case-insensitive lookup path used on every validation.
CREATE INDEX IF NOT EXISTS idx_subscription_coupons_code_active
  ON subscription_coupons (code) WHERE is_active;

-- What was actually applied, denormalised onto the payment so an invoice can be
-- reproduced without joining the ledger.
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS coupon_code  TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS discount_inr INTEGER;

COMMENT ON COLUMN subscription_payments.discount_inr IS
  'Coupon discount applied to this charge, in whole rupees. NULL when no coupon was used.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Every other public table carries a deny-all policy for the PostgREST roles
-- (see migrations 059, 090, 100). These hold commercial terms and a redemption
-- ledger, so they follow the same rule rather than becoming the next gap. The
-- Express backend connects as a BYPASSRLS role and is unaffected.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_coupons', 'subscription_coupon_redemptions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated '
      'USING (false) WITH CHECK (false)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
