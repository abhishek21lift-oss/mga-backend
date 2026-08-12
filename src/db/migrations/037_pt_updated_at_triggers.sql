-- ============================================================
-- 037_pt_updated_at_triggers.sql
-- ISSUE-018: Add BEFORE UPDATE triggers to keep updated_at
-- current on pt_clients, pt_trainers, and pt_payments.
-- All three tables have an updated_at column (verified in
-- migrations 017 and 018).
-- ============================================================

-- Shared trigger function that sets updated_at to NOW()
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ── pt_clients ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_pt_clients_updated_at ON pt_clients;
CREATE TRIGGER trg_pt_clients_updated_at
  BEFORE UPDATE ON pt_clients
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── pt_trainers ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_pt_trainers_updated_at ON pt_trainers;
CREATE TRIGGER trg_pt_trainers_updated_at
  BEFORE UPDATE ON pt_trainers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── pt_payments ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_pt_payments_updated_at ON pt_payments;
CREATE TRIGGER trg_pt_payments_updated_at
  BEFORE UPDATE ON pt_payments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
