-- ============================================================
-- 113_subscription_upi_checkout.sql
--
-- The missing step in admin-activated billing.
--
-- Today a studio can only press "request activation": the operator gets a
-- notification and has to establish, out of band, whether money actually
-- arrived. There is no amount the studio is held to, no reference to check
-- against a bank statement, and no queue — only a notification.
--
-- This adds the payment itself:
--   studio admin picks a plan
--     -> a request is opened at a SERVER-COMPUTED price
--     -> the platform's UPI QR is shown with that amount locked in
--     -> the admin pays, types the UTR, submits
--     -> the request lands in the operator's command centre
--     -> the operator approves, and subscription.activate() runs
--
-- ── Two payment systems, deliberately separate ─────────────────
-- Migration 112 handles a studio's MEMBERS paying THE STUDIO for
-- gym memberships. This one handles a STUDIO paying THE PLATFORM
-- for its subscription. Different payer, different payee,
-- different approver, different thing activated. They share the
-- UPI primitives in lib/upiPayments.js and nothing else — fusing
-- them would mean one table where organization_id sometimes means
-- "who is paying" and sometimes "who is being paid".
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. platform_payment_settings — the PLATFORM OWNER's payee details
-- ════════════════════════════════════════════════════════════
--
-- Exactly one row, ever. This is the operator's own UPI address, shown to
-- every studio on every plan — it is not per-tenant, and a tenant must never
-- be able to write it. `singleton` is a CHECK-pinned primary key rather than a
-- UUID so a second row is impossible rather than merely discouraged: two rows
-- here would mean two different QR codes for the same platform, and half the
-- studios paying into an account nobody is watching.
CREATE TABLE IF NOT EXISTS platform_payment_settings (
  singleton         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),

  upi_id            TEXT NOT NULL CHECK (upi_id ~ '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,63}$'),
  merchant_name     TEXT NOT NULL CHECK (length(btrim(merchant_name)) BETWEEN 1 AND 120),

  -- Shown on the checkout page under the QR. Where the operator sets
  -- expectations, e.g. "Verified within 2 hours, 9am-9pm".
  instructions      TEXT,

  -- Off until the operator has entered a real VPA. A studio must never be
  -- shown a QR that points nowhere.
  is_enabled        BOOLEAN NOT NULL DEFAULT FALSE,

  -- How long a checkout stays payable before the sweep closes it.
  request_ttl_minutes INT NOT NULL DEFAULT 60 CHECK (request_ttl_minutes BETWEEN 5 AND 1440),

  updated_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- 2. subscription_payment_requests — one studio's attempt to pay
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS subscription_payment_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Human reference, quoted in support chats and printed on the receipt.
  request_no        TEXT NOT NULL UNIQUE,

  plan_code         TEXT NOT NULL REFERENCES subscription_plans(code),

  -- ── The price, SNAPSHOTTED ──
  -- subscription_plans.price_inr can be edited, founder pricing can be
  -- granted, and a coupon can be exhausted by someone else — so the figure the
  -- studio was actually shown is frozen here at creation. Approval charges
  -- THIS amount. Reading through to the plan at approval time would let the
  -- catalogue silently rewrite what a studio agreed to pay.
  --
  -- Whole rupees, matching subscription_plans.price_inr and
  -- subscription_payments.amount_inr. UPI cannot transfer paise reliably
  -- anyway, and mixing a NUMERIC here with INTEGER everywhere else in the
  -- billing chain is how rounding disputes start.
  list_price_inr    INTEGER NOT NULL CHECK (list_price_inr >= 0),
  discount_inr      INTEGER NOT NULL DEFAULT 0 CHECK (discount_inr >= 0),
  amount_inr        INTEGER NOT NULL CHECK (amount_inr > 0),
  coupon_code       TEXT,

  -- Snapshot of the payee too, so a receipt reprinted after the operator
  -- changes VPA still names the account the money actually went to.
  upi_id            TEXT NOT NULL,
  merchant_name     TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT'
                    CHECK (status IN ('AWAITING_PAYMENT','AWAITING_VERIFICATION',
                                      'APPROVED','REJECTED','CANCELLED','EXPIRED')),

  expires_at        TIMESTAMPTZ NOT NULL,

  -- ── The claim ──
  utr               TEXT CHECK (utr IS NULL OR utr ~ '^[0-9]{12,16}$'),
  screenshot_url    TEXT,
  payer_note        TEXT,
  submitted_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  submitted_at      TIMESTAMPTZ,

  -- ── The operator's decision ──
  reviewed_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  rejected_reason   TEXT CHECK (rejected_reason IS NULL OR rejected_reason IN
                      ('DUPLICATE_UTR','WRONG_UTR','PAYMENT_NOT_RECEIVED',
                       'AMOUNT_MISMATCH','FAKE_SCREENSHOT','OTHER')),
  rejected_note     TEXT,

  -- What the approval produced. Links the request to the money and the period.
  payment_id        UUID REFERENCES subscription_payments(id) ON DELETE SET NULL,

  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A request awaiting verification must carry the reference being verified.
  -- Without this a studio could reach the operator's queue having submitted
  -- nothing to check.
  CONSTRAINT sub_pay_req_utr_present_when_submitted CHECK (
    (status = 'AWAITING_VERIFICATION' AND utr IS NOT NULL AND submitted_at IS NOT NULL)
    OR status <> 'AWAITING_VERIFICATION'
  ),
  -- A rejection must say why; a non-rejection must not carry a stale reason.
  CONSTRAINT sub_pay_req_reason_matches_status CHECK (
    (status = 'REJECTED' AND rejected_reason IS NOT NULL) OR
    (status <> 'REJECTED' AND rejected_reason IS NULL)
  ),
  -- Discount cannot exceed the list price, and the arithmetic must hold.
  CONSTRAINT sub_pay_req_amount_arithmetic CHECK (
    discount_inr <= list_price_inr AND amount_inr = list_price_inr - discount_inr
  )
);

-- ── DUPLICATE UTR PROTECTION ────────────────────────────────
-- Platform-wide, NOT per-organization — the opposite of migration 112, and
-- deliberately so. There is one payee here (the platform), so two studios
-- quoting the same UTR means one of them is claiming someone else's transfer.
-- Scoping this per-tenant would make exactly that attack invisible.
--
-- REJECTED rows are excluded so a mistyped-then-corrected reference can be
-- resubmitted; genuine reuse is what the DUPLICATE_UTR reason is for.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_pay_req_live_utr
  ON subscription_payment_requests (utr)
  WHERE utr IS NOT NULL AND status <> 'REJECTED';

-- ONE OPEN REQUEST PER STUDIO. A studio hammering "Pay" must not fill the
-- operator's queue with duplicates of itself; the API hands back the existing
-- open request instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_pay_req_one_open_per_org
  ON subscription_payment_requests (organization_id)
  WHERE status IN ('AWAITING_PAYMENT','AWAITING_VERIFICATION');

CREATE INDEX IF NOT EXISTS idx_sub_pay_req_status
  ON subscription_payment_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_pay_req_org
  ON subscription_payment_requests (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_pay_req_open_expiry
  ON subscription_payment_requests (expires_at)
  WHERE status = 'AWAITING_PAYMENT';

-- ════════════════════════════════════════════════════════════
-- Sequence + triggers
-- ════════════════════════════════════════════════════════════
-- Sequence rather than Date.now()+random, for the same reason receipt numbers
-- use one (src/db/receipts.js): the millisecond form collides under
-- concurrency and surfaces as a 500 in the payer's face mid-checkout.
CREATE SEQUENCE IF NOT EXISTS subscription_request_no_seq START 5001;

DROP TRIGGER IF EXISTS trg_platform_payment_settings_updated_at ON platform_payment_settings;
CREATE TRIGGER trg_platform_payment_settings_updated_at
  BEFORE UPDATE ON platform_payment_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sub_pay_req_updated_at ON subscription_payment_requests;
CREATE TRIGGER trg_sub_pay_req_updated_at
  BEFORE UPDATE ON subscription_payment_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════════════════════
-- RLS deny-all, matching every other billing table (100/104/111/112)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_payment_settings','subscription_payment_requests']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
