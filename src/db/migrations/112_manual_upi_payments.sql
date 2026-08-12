-- ============================================================
-- 112_manual_upi_payments.sql
--
-- Manual UTR verification payments: a member pays the studio over
-- UPI using any app, types the bank reference (UTR) back into the
-- app, and a studio admin verifies it by eye against their bank
-- statement. No payment gateway, no per-transaction fee, no
-- monthly platform cost.
--
-- ── Why five tables and not one ─────────────────────────────
-- An order (what was asked for, at what price) and a submission
-- (a claim that money moved, with evidence) have different
-- lifecycles: one order can accumulate several submissions when
-- the first UTR is rejected and the member tries again. Folding
-- them together would either lose the rejected attempts or
-- duplicate the priced order on every retry.
--
--   payment_settings     per-studio UPI config (VPA, GST, on/off)
--   payment_orders       priced intent to buy a membership
--   payment_submissions  one UTR claim against an order
--   payment_audit_logs   append-only trail of every transition
--   membership_payments  the activation an approval produced
--
-- ── Money is never a float ──────────────────────────────────
-- Every amount is NUMERIC(12,2). The whole ledger this feeds
-- (pt_payments) is NUMERIC, and mixing in a float here would let
-- rounding error walk into a receipt.
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. payment_settings — one row per studio
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The studio's UPI address, e.g. "studio@okhdfcbank". Format is checked
  -- here as well as in the API: a malformed VPA produces a QR code that
  -- every UPI app silently refuses, which is near-impossible to debug from
  -- a member's "it didn't work".
  upi_id            TEXT NOT NULL CHECK (upi_id ~ '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,63}$'),

  -- Shown in the payee field of the UPI app. Members abandon payments to a
  -- name they don't recognise, so this is required rather than derived.
  merchant_name     TEXT NOT NULL CHECK (length(btrim(merchant_name)) BETWEEN 1 AND 120),

  -- Optional GST. 0 means "not charged" — the payment page then hides the
  -- line entirely rather than printing "GST ₹0.00".
  gst_percent       NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (gst_percent >= 0 AND gst_percent <= 100),
  gst_number        TEXT,

  -- Master switch. Off by default: a studio that has not entered its own
  -- VPA must not be able to show members a payment page pointing nowhere.
  is_enabled        BOOLEAN NOT NULL DEFAULT FALSE,

  -- Free-text shown under the QR, e.g. "Payments are verified within 2
  -- hours during working hours."
  instructions      TEXT,

  -- How long an unpaid order stays open before the expiry sweep closes it.
  order_ttl_minutes INT NOT NULL DEFAULT 60 CHECK (order_ttl_minutes BETWEEN 5 AND 1440),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payment_settings_org_unique UNIQUE (organization_id)
);

-- ════════════════════════════════════════════════════════════
-- 2. payment_orders — a priced intent to buy
-- ════════════════════════════════════════════════════════════
--
-- The membership is SNAPSHOTTED, not referenced. plans.final_amount can be
-- edited by an admin at any time; if the order read through to the plan, a
-- price change would silently rewrite what a member already paid, and the
-- receipt would stop matching the bank statement. plan_id is kept for
-- reporting only and is deliberately ON DELETE SET NULL.
CREATE TABLE IF NOT EXISTS payment_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Human-facing reference. Printed on the receipt and quoted in support
  -- chats, because a UUID cannot be read down a phone line.
  order_no          TEXT NOT NULL,

  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  plan_id           TEXT REFERENCES plans(id) ON DELETE SET NULL,

  -- ── Snapshot of what was sold ──
  plan_name         TEXT NOT NULL CHECK (length(btrim(plan_name)) BETWEEN 1 AND 160),
  duration_months   INT  NOT NULL CHECK (duration_months BETWEEN 1 AND 120),
  base_amount       NUMERIC(12,2) NOT NULL CHECK (base_amount >= 0),
  gst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (gst_percent >= 0 AND gst_percent <= 100),
  gst_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),

  -- What the member is actually asked to transfer. Must be positive: a
  -- zero-rupee UPI intent is rejected by every app, and a negative one is
  -- nonsense.
  total_amount      NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),

  -- Snapshot of the payee too, so a receipt reprinted after the studio
  -- changes its VPA still shows the account the money actually went to.
  upi_id            TEXT NOT NULL,
  merchant_name     TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'CREATED'
                    CHECK (status IN ('CREATED','PAYMENT_PENDING','VERIFICATION_PENDING',
                                      'APPROVED','REJECTED','CANCELLED','EXPIRED')),

  -- Set at creation from payment_settings.order_ttl_minutes. The sweep in
  -- expireStaleOrders() only ever touches rows that are still CREATED or
  -- PAYMENT_PENDING, so an order awaiting verification never expires out
  -- from under an admin.
  expires_at        TIMESTAMPTZ NOT NULL,

  notes             TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payment_orders_org_no_unique UNIQUE (organization_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_org_status
  ON payment_orders (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_client
  ON payment_orders (client_id, created_at DESC);
-- Drives the expiry sweep without a full scan.
CREATE INDEX IF NOT EXISTS idx_payment_orders_open_expiry
  ON payment_orders (expires_at)
  WHERE status IN ('CREATED','PAYMENT_PENDING');

-- ONE OPEN ORDER PER CLIENT PER PLAN. Without this, a member who taps "Pay"
-- three times gets three live orders and three chances to activate the same
-- membership. The API reuses the existing open order instead of creating a
-- second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_one_open_per_plan
  ON payment_orders (organization_id, client_id, COALESCE(plan_id, ''), plan_name)
  WHERE status IN ('CREATED','PAYMENT_PENDING','VERIFICATION_PENDING');

-- ════════════════════════════════════════════════════════════
-- 3. payment_submissions — one UTR claim against an order
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_order_id  UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,

  -- The bank's UPI reference. NPCI issues 12 digits; some PSP apps surface a
  -- longer internal reference, so the window is 12-16 and numeric only. This
  -- is enforced here as well as in the DTO because it is the one field the
  -- entire verification depends on.
  utr               TEXT NOT NULL CHECK (utr ~ '^[0-9]{12,16}$'),

  -- Object key path returned by lib/fileStorage.js (R2 in production, disk
  -- in dev). Never a client-supplied URL — see the route.
  screenshot_url    TEXT,
  screenshot_mime   TEXT,
  screenshot_bytes  INT CHECK (screenshot_bytes IS NULL OR screenshot_bytes > 0),

  notes             TEXT,

  status            TEXT NOT NULL DEFAULT 'VERIFICATION_PENDING'
                    CHECK (status IN ('VERIFICATION_PENDING','APPROVED','REJECTED','CANCELLED')),

  submitted_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  verified_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_at       TIMESTAMPTZ,

  rejected_reason   TEXT CHECK (rejected_reason IS NULL OR rejected_reason IN
                      ('DUPLICATE_UTR','WRONG_UTR','PAYMENT_NOT_RECEIVED',
                       'AMOUNT_MISMATCH','FAKE_SCREENSHOT','OTHER')),
  rejected_note     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A row cannot claim to be rejected without saying why, and cannot carry a
  -- reason unless it is rejected. Both halves matter: the first stops an
  -- admin rejecting silently, the second stops a stale reason surviving a
  -- later approval.
  CONSTRAINT payment_submissions_reason_matches_status CHECK (
    (status = 'REJECTED' AND rejected_reason IS NOT NULL) OR
    (status <> 'REJECTED' AND rejected_reason IS NULL)
  ),
  -- Likewise for the verification stamp.
  CONSTRAINT payment_submissions_verified_stamp CHECK (
    (status IN ('APPROVED','REJECTED') AND verified_at IS NOT NULL) OR
    (status IN ('VERIFICATION_PENDING','CANCELLED') AND verified_at IS NULL)
  )
);

-- ── DUPLICATE UTR PROTECTION ────────────────────────────────
-- One live claim per UTR per studio.
--
-- Scoped to the organization, not global: a global constraint would let one
-- studio discover that a UTR exists in another studio's books by watching
-- for a 409, which is a cross-tenant information leak in a system whose
-- whole point is tenant isolation.
--
-- REJECTED rows are excluded on purpose. "Payment not received" is
-- sometimes an admin's mistake, or the member mistyped one digit and needs
-- to submit the correct number — which may be the one they typed before. A
-- rejected submission is void, so its number goes back in the pool. Genuine
-- reuse is what the DUPLICATE_UTR rejection reason is for.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_submissions_live_utr
  ON payment_submissions (organization_id, utr)
  WHERE status <> 'REJECTED';

-- ONE PENDING SUBMISSION PER ORDER. Stops a member double-tapping Submit
-- and putting two identical claims in the admin's queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_submissions_one_pending
  ON payment_submissions (payment_order_id)
  WHERE status = 'VERIFICATION_PENDING';

CREATE INDEX IF NOT EXISTS idx_payment_submissions_org_status
  ON payment_submissions (organization_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_order
  ON payment_submissions (payment_order_id, submitted_at DESC);

-- ════════════════════════════════════════════════════════════
-- 4. payment_audit_logs — append-only transition trail
-- ════════════════════════════════════════════════════════════
--
-- Separate from the app-wide activity_log because this one is evidence:
-- money changed hands on a human's say-so, and "who approved this, when,
-- from where" has to survive independently of whether someone later edits
-- the submission row. There is no UPDATE or DELETE path to this table
-- anywhere in the codebase.
CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_order_id  UUID REFERENCES payment_orders(id) ON DELETE CASCADE,
  submission_id     UUID REFERENCES payment_submissions(id) ON DELETE SET NULL,

  action            TEXT NOT NULL CHECK (action IN (
                      'ORDER_CREATED','ORDER_REUSED','INTENT_OPENED','UTR_SUBMITTED',
                      'SCREENSHOT_UPLOADED','APPROVED','REJECTED','CORRECTION_REQUESTED',
                      'CANCELLED','EXPIRED','MEMBERSHIP_ACTIVATED')),

  from_status       TEXT,
  to_status         TEXT,

  -- Whatever context the action carried: amounts, the rejection note, the
  -- activated membership window.
  detail            JSONB,

  actor_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name        TEXT,
  actor_role        TEXT,
  ip_address        TEXT,
  user_agent        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_audit_order
  ON payment_audit_logs (payment_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_audit_org
  ON payment_audit_logs (organization_id, created_at DESC);

-- ════════════════════════════════════════════════════════════
-- 5. membership_payments — what an approval produced
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS membership_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  payment_order_id  UUID NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  submission_id     UUID NOT NULL REFERENCES payment_submissions(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,

  -- The row written into the existing finance ledger, so UPI revenue shows
  -- up in the same reports as cash and card. Nullable only because the FK
  -- target is TEXT-keyed and may be soft-deleted later.
  pt_payment_id     TEXT,

  receipt_no        TEXT NOT NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  utr               TEXT NOT NULL,

  -- The membership window this payment bought.
  activated_from    DATE NOT NULL,
  activated_to      DATE NOT NULL,

  approved_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT membership_payments_window CHECK (activated_to > activated_from),

  -- PREVENT DUPLICATE MEMBERSHIP ACTIVATION. One activation per order, full
  -- stop. Two admins hitting Approve at the same instant: the first commits,
  -- the second violates this and the API returns 409 rather than extending
  -- the membership twice.
  CONSTRAINT membership_payments_order_unique UNIQUE (payment_order_id),
  CONSTRAINT membership_payments_receipt_unique UNIQUE (organization_id, receipt_no)
);

CREATE INDEX IF NOT EXISTS idx_membership_payments_client
  ON membership_payments (client_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_payments_org
  ON membership_payments (organization_id, approved_at DESC);

-- ════════════════════════════════════════════════════════════
-- updated_at triggers
-- ════════════════════════════════════════════════════════════
-- Every table carrying the shared set_updated_at() trigger must actually
-- have the column — a table that doesn't breaks on every UPDATE, which is
-- the exact bug migration 108 had to repair.
DROP TRIGGER IF EXISTS trg_payment_settings_updated_at ON payment_settings;
CREATE TRIGGER trg_payment_settings_updated_at
  BEFORE UPDATE ON payment_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_orders_updated_at ON payment_orders;
CREATE TRIGGER trg_payment_orders_updated_at
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_submissions_updated_at ON payment_submissions;
CREATE TRIGGER trg_payment_submissions_updated_at
  BEFORE UPDATE ON payment_submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════════════════════
-- Order number sequence
-- ════════════════════════════════════════════════════════════
-- Drawn from a sequence rather than built from Date.now() + random, for the
-- same reason receipt numbers are (see src/db/receipts.js): under
-- concurrency the millisecond+random form collides and the UNIQUE constraint
-- surfaces the collision as a 500 in the member's face mid-payment.
CREATE SEQUENCE IF NOT EXISTS payment_order_no_seq START 100001;

-- ════════════════════════════════════════════════════════════
-- RLS deny-all, matching every other tenant table (059/090/100/104/111)
-- ════════════════════════════════════════════════════════════
-- These tables are reachable only through the Express API, which connects as
-- a BYPASSRLS role and does its own tenant scoping. Anything arriving over
-- the Supabase anon/authenticated roles is denied outright — defence in
-- depth against a leaked publishable key.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_settings','payment_orders','payment_submissions',
                           'payment_audit_logs','membership_payments']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
