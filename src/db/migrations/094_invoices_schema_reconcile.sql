-- 094_invoices_schema_reconcile.sql
-- The live `invoices` table (from an early schema) diverged from what
-- src/routes/invoices.js was written against, so every invoices endpoint
-- referenced columns that don't exist and 500'd — most visibly
-- GET /api/invoices failing with "column i.issue_date does not exist".
--
-- Reconcile additively: add the columns the route reads/writes alongside the
-- existing ones (member_id, invoice_number, subtotal, issued_at, due_at, …).
-- The table is empty (0 rows), so this is behaviour-preserving. The route uses
-- client_id as the client reference, so the legacy member_id NOT NULL
-- constraint is relaxed (the column is kept for backward compatibility).

-- Guarded: member_id is part of "the live invoices table (from an early
-- schema)" this file exists to reconcile, so it is present on the live
-- database but absent from one built out of this repo — where the bare ALTER
-- aborted the migration. Nothing to relax when the column was never created.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'invoices' AND column_name = 'member_id'
  ) THEN
    ALTER TABLE invoices ALTER COLUMN member_id DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_no     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_id      TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_name    TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount         NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date     DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date       DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes          TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at        TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_amount    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS invoices_status_idx     ON invoices (status);
CREATE INDEX IF NOT EXISTS invoices_issue_date_idx ON invoices (issue_date DESC);
CREATE INDEX IF NOT EXISTS invoices_client_id_idx  ON invoices (client_id);
