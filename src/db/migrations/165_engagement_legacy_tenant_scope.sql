-- 165_engagement_legacy_tenant_scope.sql
--
-- Closes the tenant-isolation gap in the class-booking / engagement /
-- staff-leave feature set. These tables predate 078_multitenancy_foundation
-- and were never brought into the tenant model: class_sessions,
-- class_templates, bookings, offers, campaigns, leave_requests, feedback,
-- plans, branches, integrations, and the two Google Calendar tables all
-- carried no organization_id, and the routes reading them (routes/classes.js,
-- routes/offers.js, routes/campaigns.js, routes/leave.js, routes/feedback.js,
-- routes/plans.js, routes/integrations.js) had no tenant filter to apply even
-- if they had tried — a studio's class schedule, leave requests, offers and
-- campaigns were readable (leave: also writable) by any authenticated user of
-- any other studio. Unlike the /api/v1/reports, /api/v1/sessions and
-- /api/v1/members routers removed for the same reason (see server.js's ROUTE
-- INTEGRITY NOTEs), these are live, frontend-wired features
-- ((chrome)/trainers/leave, (chrome)/engagement/offers,
-- (chrome)/engagement/campaigns, (bare)/member/classes) with no already-safe
-- replacement to fall back on, so the fix here is to scope them, not delete
-- them.
--
-- Two backfill shapes are used, matching the two real situations:
--
--   1. A reliable per-row owner exists (an FK-shaped column pointing at a
--      table that already carries organization_id) → backfill by joining it.
--      class_sessions (instructor_id → trainers), bookings (session_id →
--      class_sessions), leave_requests (trainer_id → trainers, NOT NULL and
--      ON DELETE CASCADE so this is a real, ~always-resolvable link),
--      offers/campaigns (created_by → users), google_calendar_tokens/events
--      (user_id → users).
--
--   2. No reliable per-row owner exists, and the data is a small catalog
--      every studio needs its own copy of, not a shared reference table
--      (unlike exercises/diet_templates) → duplicate the existing rows once
--      per current organization, then drop the un-owned originals. plans and
--      integrations. This mirrors what a studio "starting fresh" from the
--      current global catalog would look like, and avoids the alternative of
--      guessing a single owning tenant for data that — per
--      tenantScope.convention.test.js — six real studios may currently share
--      unknowingly.
--
-- class_templates, feedback and branches have neither: no resolvable owner
-- and no "every studio needs one" catalog shape (feedback's member_id points
-- at the legacy, org-less `clients` table; branches has no route reading it
-- at all today). Their organization_id stays nullable and unbackfilled —
-- existing rows become invisible once the routes apply a strict tenant
-- filter, which is the same "silent data loss rather than a leak" tradeoff
-- 155_organization_id_not_null.sql already made for exactly this situation,
-- not a new decision invented here.
--
-- system_settings is deliberately NOT touched by this migration. It is a
-- global key/value table (PK = key) that every studio currently reads and
-- writes as if it were the only tenant, which is a real multi-tenancy bug
-- (gym_name, currency, feature flags and permissions are shared across all
-- studios) — but fixing it means changing its primary key shape
-- (key → (organization_id, key)), and scripts/db-bootstrap-verify.js STEP 11
-- asserts today that an operator's edited system_settings row survives a
-- migration re-run unchanged and unduplicated. That assertion encodes a real
-- safety property (a migration must not silently overwrite or fork an
-- operator's edit) and deserves a deliberate follow-up migration written
-- against it, not a change bundled in here where a mistake would fail
-- silently. See the note on this in the accompanying pull request.

-- ── 1. Reliable-owner backfills ─────────────────────────────────────────

ALTER TABLE class_templates ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_class_templates_organization_id ON class_templates(organization_id);

ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_class_sessions_organization_id ON class_sessions(organization_id);
UPDATE class_sessions cs
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = cs.instructor_id
   AND t.organization_id IS NOT NULL
   AND cs.organization_id IS NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_organization_id ON bookings(organization_id);
-- bookings carries a BEFORE UPDATE trigger (trg_bookings_updated_at) that
-- assumes an updated_at column the table does not actually have — a
-- pre-existing mismatch (any UPDATE on this table, including
-- bookings.service.js's own cancel(), already hits it in production) that is
-- not this migration's to fix. Disabling it around this one backfill UPDATE
-- avoids tripping over it while leaving the trigger itself untouched.
ALTER TABLE bookings DISABLE TRIGGER trg_bookings_updated_at;
UPDATE bookings b
   SET organization_id = cs.organization_id
  FROM class_sessions cs
 WHERE cs.id = b.session_id
   AND cs.organization_id IS NOT NULL
   AND b.organization_id IS NULL;
ALTER TABLE bookings ENABLE TRIGGER trg_bookings_updated_at;

ALTER TABLE offers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_offers_organization_id ON offers(organization_id);
UPDATE offers o
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = o.created_by
   AND u.organization_id IS NOT NULL
   AND o.organization_id IS NULL;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_organization_id ON campaigns(organization_id);
UPDATE campaigns c
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = c.created_by
   AND u.organization_id IS NOT NULL
   AND c.organization_id IS NULL;

ALTER TABLE google_calendar_tokens ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_google_calendar_tokens_organization_id ON google_calendar_tokens(organization_id);
UPDATE google_calendar_tokens t
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = t.user_id
   AND u.organization_id IS NOT NULL
   AND t.organization_id IS NULL;

ALTER TABLE google_calendar_events ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_organization_id ON google_calendar_events(organization_id);
UPDATE google_calendar_events e
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = e.user_id
   AND u.organization_id IS NOT NULL
   AND e.organization_id IS NULL;

-- leave_requests: trainer_id is NOT NULL with ON DELETE CASCADE to trainers,
-- so every live row resolves. Safe to tighten to NOT NULL using the same
-- count-first, warn-not-abort idiom as 155_organization_id_not_null.sql —
-- a migration that could abort a deploy over an orphaned row is worse than
-- one that leaves the column nullable and says so loudly.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests_organization_id ON leave_requests(organization_id);
UPDATE leave_requests lr
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = lr.trainer_id
   AND t.organization_id IS NOT NULL
   AND lr.organization_id IS NULL;

DO $$
DECLARE
  null_count BIGINT;
BEGIN
  SELECT count(*) INTO null_count FROM leave_requests WHERE organization_id IS NULL;
  IF null_count = 0 THEN
    ALTER TABLE leave_requests ALTER COLUMN organization_id SET NOT NULL;
  ELSE
    RAISE WARNING '165: % row(s) in leave_requests have no organization_id — leaving nullable, re-run this migration''s NOT NULL step by hand once resolved', null_count;
  END IF;
END $$;

-- ── 2. No reliable owner, "every studio needs its own copy" catalogs ───
--
-- plans: membership/PT package pricing. Every studio needs its own catalog,
-- not a shared one, and there is no created_by column to backfill from.
-- Duplicate the existing (currently-shared) rows once per organization, with
-- fresh ids — nothing references plans.id by foreign key today — then drop
-- the un-owned originals and require organization_id going forward.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

INSERT INTO plans (
  id, kind, name, description, duration, base_amount, discount, final_amount,
  joining_fee, tax_pct, sessions_per_week, features, popular, color,
  is_active, deleted_at, organization_id
)
SELECT
  gen_random_uuid()::text, p.kind, p.name, p.description, p.duration, p.base_amount,
  p.discount, p.final_amount, p.joining_fee, p.tax_pct, p.sessions_per_week,
  p.features, p.popular, p.color, p.is_active, p.deleted_at, o.id
FROM plans p
CROSS JOIN organizations o
WHERE p.organization_id IS NULL;

DELETE FROM plans WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_plans_organization_id ON plans(organization_id);
ALTER TABLE plans ALTER COLUMN organization_id SET NOT NULL;

-- integrations: id is a small fixed catalog ('razorpay', 'stripe', 'sendgrid',
-- 'twilio', …), one row per integration TYPE rather than per connection —
-- so unlike plans, the primary key itself has to become (organization_id, id)
-- or two studios could never both have a 'razorpay' row.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- Drop the id-only PK before duplicating rows — every org's copy keeps the
-- same catalog id ('razorpay' etc.), which the old single-column PK would
-- reject as a duplicate the moment a second organization exists.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_pkey;

INSERT INTO integrations (
  id, organization_id, name, status, api_key, config, connected_at, last_sync_at, created_at, updated_at
)
SELECT i.id, o.id, i.name, i.status, i.api_key, i.config, i.connected_at, i.last_sync_at, i.created_at, i.updated_at
FROM integrations i
CROSS JOIN organizations o
WHERE i.organization_id IS NULL;

DELETE FROM integrations WHERE organization_id IS NULL;

ALTER TABLE integrations ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE integrations ADD PRIMARY KEY (organization_id, id);

-- ── 3. No reliable owner, no "one per studio" shape either ──────────────
-- Left nullable and unbackfilled — see the header note.
ALTER TABLE feedback        ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_organization_id ON feedback(organization_id);

ALTER TABLE branches        ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_branches_organization_id ON branches(organization_id);

-- ── 4. RLS — cover every table this migration just added organization_id
-- to, using the exact same discover-from-schema loop 157 already applies
-- (idempotent: ENABLE ROW LEVEL SECURITY and CREATE POLICY are both safe to
-- repeat). Running it again here means these tables get the app_tenant
-- tenant_isolation policy without duplicating 157's policy-authoring logic.
DO $$
DECLARE
  tbl text;
  shared_tables text[] := ARRAY[
    'exercises', 'diet_templates', 'muscle_volume_landmarks', 'login_events',
    'users', 'workout_plans', 'storage_objects', 'user_webauthn_credentials'
  ];
BEGIN
  FOR tbl IN
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'organization_id'
       AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    IF tbl = ANY(shared_tables) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant ' ||
        'USING (organization_id::text = current_setting(''app.org_id'', true) OR organization_id IS NULL) ' ||
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true) OR organization_id IS NULL)',
        tbl
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO app_tenant ' ||
        'USING (organization_id::text = current_setting(''app.org_id'', true)) ' ||
        'WITH CHECK (organization_id::text = current_setting(''app.org_id'', true))',
        tbl
      );
    END IF;
  END LOOP;
END $$;
