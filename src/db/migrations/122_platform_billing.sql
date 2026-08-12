-- ============================================================
-- 122_platform_billing.sql
--
-- Billing Centre for the Control Centre.
--
-- Three separate concerns, all of which were missing:
--
--   1. WHO IS BILLING.  The platform's own legal identity — the seller on
--      every subscription invoice. One row, enforced by a CHECK on a fixed
--      primary key, because there is exactly one platform.
--
--   2. WHO IS BEING BILLED.  A studio's billing identity is not its display
--      name: an invoice needs the registered entity, its GSTIN and its state.
--      Kept on organizations rather than a side table because it is 1:1 and
--      every read that wants it already has the org row in hand.
--
--   3. HOW MUCH TAX.  GST is SNAPSHOTTED onto the invoice at issue time,
--      never recomputed at print time. Re-deriving it would mean that
--      changing the platform's GST rate silently rewrites last year's
--      invoices and stops them matching the returns already filed against
--      them. (Same reasoning as upiReceiptPdf.js, which learned this first.)
--
-- Deliberately NOT changing what anyone is charged. amount_inr stays the
-- gross, tax-inclusive figure that was actually collected; the new columns
-- record how that figure splits. Existing rows get NULL and render as
-- "tax not itemised", which is the truth about them.
--
-- Idempotent.
-- ============================================================

-- ── 1. Platform seller identity ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_billing_settings (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- singleton
  legal_name          TEXT,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  state               TEXT,
  state_code          TEXT,          -- GST state code, e.g. '27' for Maharashtra
  postal_code         TEXT,
  country             TEXT NOT NULL DEFAULT 'India',
  gstin               TEXT,
  pan                 TEXT,
  email               TEXT,
  phone               TEXT,
  -- Applied to invoices issued from now on. Historical invoices keep the rate
  -- that was in force when they were issued, because it is stored on them.
  gst_percent         NUMERIC(5,2) NOT NULL DEFAULT 18
                      CHECK (gst_percent >= 0 AND gst_percent <= 100),
  -- Prices are quoted to studios inclusive of tax, so the invoice splits the
  -- collected amount rather than adding to it. FALSE would mean tax on top,
  -- which would change what is charged — hence the default that preserves
  -- today's behaviour exactly.
  prices_include_gst  BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_prefix      TEXT NOT NULL DEFAULT 'MPT',
  invoice_notes       TEXT,          -- printed in the footer: terms, bank details
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

INSERT INTO platform_billing_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── 2. Studio billing identity ───────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_name          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email         TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_gstin         TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line1 TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line2 TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_city          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_state         TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_state_code    TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_postal_code   TEXT;

-- ── 3. Tax snapshot on the invoice ───────────────────────────────────────────
-- NUMERIC(12,2), not INTEGER: a tax split of an integer rupee amount lands on
-- paise. Rounding each component to whole rupees would make the parts stop
-- summing to the total, which is exactly the kind of ₹1 discrepancy that costs
-- an accountant an afternoon.
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS taxable_value_inr NUMERIC(12,2);
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS gst_percent       NUMERIC(5,2);
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS cgst_inr          NUMERIC(12,2);
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS sgst_inr          NUMERIC(12,2);
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS igst_inr          NUMERIC(12,2);
-- Frozen copies of both parties as they were on the issue date. An invoice
-- that re-reads the studio's current address would change after the fact when
-- the studio moves — a document that mutates is not evidence of anything.
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS seller_snapshot   JSONB;
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS buyer_snapshot    JSONB;

-- The Billing Centre's default view is "all studios, newest first", which is
-- the one ordering the existing per-org index cannot serve.
CREATE INDEX IF NOT EXISTS idx_sub_invoices_issued  ON subscription_invoices(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_invoices_status  ON subscription_invoices(status, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_invoices_number  ON subscription_invoices(invoice_number);

-- ── Row Level Security (added retroactively — audit finding C-01) ────
--
-- This migration created the table(s) below without RLS, leaving them
-- reachable through PostgREST with the publishable key. Migration 131
-- swept the live database, but 131 sorts BEFORE this file: a database
-- rebuilt from scratch would run the sweep first and then recreate the
-- gap here. Declaring it in the migration that owns the table makes it
-- order-independent and self-contained.
--
-- Idempotent; already-applied databases are unaffected.

ALTER TABLE platform_billing_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_billing_settings FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_billing_settings'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_billing_settings
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
