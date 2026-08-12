-- ============================================================
-- 128_storage_accounting.sql
--
-- Per-studio storage accounting — the last of the four sources the
-- Executive Dashboard needs (AI usage, support tickets and churn
-- already exist).
--
-- ── Why a ledger rather than listing the bucket ──────────────────────
--
-- Object keys are `category/filename` with no studio in the path, so
-- listing R2 cannot attribute a byte to anyone. Attribution has to be
-- recorded at write time or not at all. Listing would also be a paged
-- scan of the whole bucket on every page load.
--
-- ── This measures FROM NOW ON, and says so ───────────────────────────
--
-- Objects written before this migration have no row here, so the totals
-- are storage accounted since the migration ran, not total storage.
-- `measuring_since` is returned by the API and shown in the UI for the
-- same reason the Billing Centre labels un-itemised invoices and the AI
-- Control Centre names unpriced models: a partial number presented as a
-- total is worse than an obviously partial one, because it gets
-- budgeted against.
--
-- Backfilling is possible later — walk the bucket, match keys to the
-- rows that reference them — but guessing at it now would produce a
-- confident number nobody could reproduce.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS storage_objects (
  -- The object key IS the identity. Writing the same key twice replaces
  -- the object in R2, so the row must be replaced too rather than
  -- double-counted.
  key             TEXT PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,
  bytes           BIGINT NOT NULL CHECK (bytes >= 0),
  content_type    TEXT,
  uploaded_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: the row survives so "how much did this studio ever
  -- upload" stays answerable after a purge, while live usage counts only
  -- rows where this is NULL. ON DELETE SET NULL above means a deleted
  -- studio's objects become unattributed rather than vanishing from the
  -- platform total, which is what is true — the bytes are still there
  -- until something removes them.
  deleted_at      TIMESTAMPTZ
);

-- The per-studio rollup, which is the only query the dashboard runs.
CREATE INDEX IF NOT EXISTS idx_storage_org ON storage_objects (organization_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_storage_category ON storage_objects (category)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_storage_created ON storage_objects (created_at DESC);

-- When accounting started, so the API can say what the totals do and do
-- not include. A table rather than a constant: the answer must survive a
-- redeploy and must not change if this migration is re-run.
CREATE TABLE IF NOT EXISTS storage_accounting_meta (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  measuring_since TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO storage_accounting_meta (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

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

ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON storage_objects FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'storage_objects'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON storage_objects
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE storage_accounting_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON storage_accounting_meta FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'storage_accounting_meta'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON storage_accounting_meta
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
