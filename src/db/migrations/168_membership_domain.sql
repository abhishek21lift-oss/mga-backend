-- 168_membership_domain.sql
--
-- Phase 3: gym memberships. The thing a gym actually sells.
--
-- Until now the product had no membership entity at all. Migration 021 dropped
-- `subscriptions` and `renewals`; what remained was `pt_client_subscriptions` —
-- PT package terms — plus a set of date columns on the person record
-- (pt_clients.pt_start_date / pt_end_date / duration_months). So the only thing
-- a studio could sell was personal training, and "membership" meant "the dates
-- on a PT client".
--
-- ── A gym membership is not a PT package ────────────────────────────────────
--
-- docs/GMS_TARGET_ARCHITECTURE.md §3 sets this out and it is the whole reason
-- these are separate tables rather than a `kind` column on one:
--
--   Gym membership   grants building access for a period. Priced by duration.
--                    Consumed by time passing.
--   PT package       grants N sessions with a trainer. Priced by sessions and
--                    trainer. Consumed by a session being delivered.
--
-- They expire differently, are renewed differently, are reported differently,
-- and a member can hold both, either, or neither. `pt_packages` stays exactly
-- where it is.
--
-- ── What is deliberately NOT migrated from `plans` ──────────────────────────
--
-- `plans` holds rows with kind IN ('Membership','PT') and has no
-- organization_id — V-03 in TENANT_SECURITY_AUDIT.md, one of the sixteen tables
-- gated on a read-only production count because a row belongs to one studio and
-- nothing records which.
--
-- Phase 2a could fan `system_settings` out without that count because those
-- values were shared BY DESIGN. This is not the same case, and the difference
-- matters: a plan row was created by one studio. Copying "Gold Annual, ₹25,000"
-- into all six studios' catalogues would preserve today's (broken) behaviour
-- while making the leak permanent and duplicating another studio's pricing as
-- if it were their own.
--
-- So `membership_plans` starts EMPTY and each studio creates its own. That is
-- the honest state for a new domain, and it leaves `plans` and `/api/plans`
-- exactly as they are until the count decides their fate. Nothing here depends
-- on that decision.
--
-- ── One membership per member is NOT enforced ───────────────────────────────
--
-- No partial unique on (member_id) WHERE status IN ('active','frozen'). Renewing
-- before expiry is normal: a studio sells the next term while the current one
-- still runs, which means two non-expired rows for one member. The "current"
-- membership is the one with the latest ends_on, and the routes read it that
-- way. A constraint here would reject the most ordinary renewal there is.

-- ── Plan catalogue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_plans (
  id              TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id UUID          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            TEXT          NOT NULL,
  description     TEXT,

  -- Days, not months. 30/90/180/365 are the common cases, but a studio selling
  -- a 45-day summer pass or a 14-day trial should not have to express it as a
  -- fraction of a month — which is what pt_client_subscriptions.duration_months
  -- NUMERIC(5,1) was doing.
  duration_days   INT           NOT NULL CHECK (duration_days > 0),

  price           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  joining_fee     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (joining_fee >= 0),
  -- 18 matches the existing `plans.tax_pct` default rather than introducing a
  -- second convention. A studio that charges no tax sets 0; one in another
  -- jurisdiction sets its own rate.
  tax_pct         NUMERIC(5,2)  NOT NULL DEFAULT 18 CHECK (tax_pct >= 0),

  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order      INT           NOT NULL DEFAULT 0,

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_plans_org ON membership_plans(organization_id);

-- Tenant-scoped, never global. V-15 records the same defect on pt_plans, whose
-- bare `UNIQUE (name)` means two studios cannot both have a plan called
-- "Basic" — and every studio wants to call something "Basic".
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_plans_org_name
  ON membership_plans(organization_id, lower(name)) WHERE deleted_at IS NULL;

-- ── Memberships ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id UUID          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- RESTRICT, matching pt_clients.member_id in migration 166: removing a member
  -- must not silently take their membership and payment history with it. The
  -- application soft-deletes.
  member_id       TEXT          NOT NULL REFERENCES members(id) ON DELETE RESTRICT,

  -- SET NULL, not RESTRICT: retiring a plan from the catalogue must not be
  -- blocked by history, and must not rewrite it either.
  plan_id         TEXT          REFERENCES membership_plans(id) ON DELETE SET NULL,

  -- Snapshot of what was sold, deliberately denormalised. A plan can be renamed
  -- or retired years after the fact, and an invoice reprinted then has to say
  -- what the member actually bought. The same reasoning the invoice_items
  -- description already follows.
  plan_name       TEXT          NOT NULL,

  starts_on       DATE          NOT NULL,
  ends_on         DATE          NOT NULL,

  status          TEXT          NOT NULL DEFAULT 'active'
                  CHECK (status IN ('pending','active','frozen','expired','cancelled')),

  -- Money as charged, not as catalogued — a discount applies to this sale only.
  price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  joining_fee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,

  notes           TEXT,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_by      TEXT          REFERENCES users(id) ON DELETE SET NULL,

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT memberships_window CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_memberships_org        ON memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_member     ON memberships(organization_id, member_id);
-- The expiry sweep's access path: "active memberships in this studio ending on
-- this date". Without it the reminder worker seq-scans once per organization
-- per reminder window, every night.
CREATE INDEX IF NOT EXISTS idx_memberships_expiry     ON memberships(organization_id, status, ends_on);

-- ── Freezes ─────────────────────────────────────────────────────────────────
--
-- A freeze suspends a membership and pushes ends_on out by the number of days
-- frozen, so the member does not lose paid time. `days` is written on resume
-- rather than at freeze time, because an open-ended freeze does not yet know
-- its length — resuming early is the normal case.
CREATE TABLE IF NOT EXISTS membership_freezes (
  id              TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id UUID          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id   TEXT          NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,

  from_date       DATE          NOT NULL,
  to_date         DATE,
  days            INT,

  reason          TEXT,
  created_by      TEXT          REFERENCES users(id) ON DELETE SET NULL,
  resumed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT membership_freezes_window CHECK (to_date IS NULL OR to_date >= from_date)
);

CREATE INDEX IF NOT EXISTS idx_membership_freezes_membership ON membership_freezes(membership_id);
CREATE INDEX IF NOT EXISTS idx_membership_freezes_org        ON membership_freezes(organization_id);

-- Only one freeze may be open on a membership at a time. Two would make the
-- resume arithmetic ambiguous — which of them does the extension belong to.
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_freezes_open
  ON membership_freezes(membership_id) WHERE resumed_at IS NULL;

-- ── Lifecycle events ────────────────────────────────────────────────────────
--
-- ONE table with a `kind`, not the four the brief lists (renewals,
-- cancellations, changes, …). They share every column and differ only in that
-- value, so four tables would mean four sets of reports, four backfills, and
-- four places to forget a tenant predicate. Freezes stay separate because they
-- carry a date range and mutate ends_on; these only record.
CREATE TABLE IF NOT EXISTS membership_events (
  id              TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id UUID          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id   TEXT          NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,

  kind            TEXT          NOT NULL
                  CHECK (kind IN ('created','renewed','upgraded','downgraded',
                                  'cancelled','frozen','resumed','expired','transferred')),

  from_plan_id    TEXT,
  to_plan_id      TEXT,
  from_ends_on    DATE,
  to_ends_on      DATE,
  effective_on    DATE          NOT NULL DEFAULT CURRENT_DATE,

  amount          NUMERIC(12,2),
  actor_id        TEXT          REFERENCES users(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_events_membership ON membership_events(membership_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_events_org_kind   ON membership_events(organization_id, kind, effective_on);

-- ── Row Level Security, house pattern ───────────────────────────────────────
--
-- Deny-all rather than organization-scoped policies, matching every other table
-- here. The API connects as the table owner and bypasses RLS entirely; these
-- exist to make the anon/authenticated PostgREST keys inert. See
-- 148_staff_tables_rls.sql for why this is the deliberate house pattern, and
-- db/migrations/TENANT-RLS-PLAN.md for the org-scoped policies that replace it
-- once the app_tenant role lands — which will pick these four up automatically,
-- because migration 157 discovers tables BY the organization_id column.
-- Written out per table rather than looped over an ARRAY, and that is on
-- purpose. src/__tests__/rls.convention.test.js reads these files statically —
-- CI has no database, and a runtime check would only catch the omission after it
-- shipped. A `FOREACH t IN ARRAY … EXECUTE format(…)` loop is invisible to it,
-- so a migration that protected its tables that way would be reported as
-- protecting none, and the honest way to satisfy a guard is to be legible to it
-- rather than to teach it to accept a form it cannot verify.
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON membership_plans FROM anon, authenticated;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON memberships FROM anon, authenticated;

ALTER TABLE membership_freezes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON membership_freezes FROM anon, authenticated;

ALTER TABLE membership_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON membership_events FROM anon, authenticated;

DO $rls$
DECLARE t text;
BEGIN
  -- The policy creation stays dynamic: it is guarded on pg_policies for
  -- idempotency, which needs a lookup per table, and the guard checks for
  -- ENABLE ROW LEVEL SECURITY and REVOKE above rather than the policy body.
  FOREACH t IN ARRAY ARRAY['membership_plans','memberships','membership_freezes','membership_events']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND policyname = 'deny_all_direct_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY deny_all_direct_access ON %I FOR ALL USING (false) WITH CHECK (false)', t);
    END IF;
  END LOOP;
END $rls$;

-- ── Report ──────────────────────────────────────────────────────────────────
--
-- No backfill and no seed. A studio's plan catalogue is theirs to write, and
-- inventing "Basic / Premium / Gold" rows would be fabricating product data —
-- the placeholder-records problem the transformation brief rules out.
DO $report$
BEGIN
  RAISE NOTICE '[168] Membership domain created (membership_plans, memberships, membership_freezes, membership_events). Catalogue starts empty; each studio creates its own plans.';
  RAISE NOTICE '[168] `plans` and /api/plans are untouched — still V-03, still gated on a production count. Nothing here depends on that.';
END $report$;
