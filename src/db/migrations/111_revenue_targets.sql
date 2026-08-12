-- ============================================================
-- 111_revenue_targets.sql
--
-- Monthly revenue target a studio admin commits to at the start
-- of a month.
--
-- ── The lock is a constraint, not a UI state ────────────────
-- The requirement is that a target can be set ONCE per month and
-- cannot then be changed. Enforcing that by disabling an input is
-- not enforcement at all — anyone can POST the endpoint directly.
--
-- `UNIQUE (organization_id, period)` is what actually makes it
-- true: a second insert for the same month fails at the database
-- no matter which code path attempts it. The API turns that
-- violation into a 409, and there is deliberately NO update route,
-- so there is no supported way to change a committed target.
--
-- `period` is the first day of the month (date_trunc('month')),
-- normalised by a CHECK so a caller cannot sneak two rows into one
-- month by sending different days.
--
-- Targets are historical records: last month's target stays for
-- comparison once the month rolls over, and the studio sets a fresh
-- one for the new period.
-- ============================================================

CREATE TABLE IF NOT EXISTS revenue_targets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- First day of the month this target belongs to.
  period           DATE NOT NULL CHECK (period = date_trunc('month', period)::date),

  -- A target of zero is meaningless and negative is nonsense; both are
  -- rejected here so the API cannot be talked into storing one.
  target_amount    NUMERIC(12, 2) NOT NULL CHECK (target_amount > 0),

  set_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- THE LOCK. One target per studio per month, enforced by the database.
  CONSTRAINT revenue_targets_org_period_unique UNIQUE (organization_id, period)
);

-- The only read pattern: "this studio's target for this month", and
-- "this studio's recent targets" for history. Both are covered.
CREATE INDEX IF NOT EXISTS idx_revenue_targets_org_period
  ON revenue_targets (organization_id, period DESC);

-- Present because the shared set_updated_at() trigger writes it. A table
-- carrying that trigger without this column breaks on every UPDATE —
-- that exact bug shipped once before (see migration 108).
DROP TRIGGER IF EXISTS trg_revenue_targets_updated_at ON revenue_targets;
CREATE TRIGGER trg_revenue_targets_updated_at
  BEFORE UPDATE ON revenue_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS deny-all, matching every other tenant table in this schema
-- (059, 090, 100, 104): reachable only through the Express API, which
-- connects as a BYPASSRLS role and does its own tenant scoping.
ALTER TABLE public.revenue_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_direct_access ON public.revenue_targets;
CREATE POLICY deny_all_direct_access ON public.revenue_targets
  AS PERMISSIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
REVOKE ALL ON public.revenue_targets FROM anon, authenticated;
