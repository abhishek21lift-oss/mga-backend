-- 158_activity_log_organization_id.sql
-- Screening-section audit found the studio-facing gap this closes: the app
-- has activity_log (lib/activityLog.js) writing real rows for profile/
-- PAR-Q/consent/login events, but nothing scoped it to a tenant and nothing
-- wired it into the business writes that matter most — a client created or
-- edited, a payment recorded or removed, a trainer's commission changed.
-- This migration adds the column those need; the routes are wired up in the
-- same PR.

ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_activity_log_organization_id ON activity_log (organization_id, created_at DESC);

-- Production has a BEFORE UPDATE trigger on activity_log that this repo's
-- migrations never created (001_v4_upgrade.sql's set_updated_at() loop only
-- covers users/trainers/clients/system_settings/leave_requests — activity_log
-- is not in that list, and no other tracked migration touches it either).
-- Whatever attached it did so out-of-band, and it references a column
-- (updated_at) the table has never had, so the backfill UPDATE below fails
-- with "record "new" has no field "updated_at"" the moment it runs. Dropped
-- here rather than worked around: an append-only log table (see 120's own
-- comment) has no legitimate reason to carry an updated_at trigger at all.
DO $$
DECLARE trg text;
BEGIN
  FOR trg IN
    SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'public.activity_log'::regclass AND NOT tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.activity_log', trg);
  END LOOP;
END $$;

-- Backfill from the acting user's own org, same shape as 084/156. Rows with
-- no resolvable user (a deleted account) or a genuinely org-less actor (the
-- platform super-admin) are left NULL rather than guessed at.
UPDATE activity_log a
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = a.user_id
   AND a.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

UPDATE activity_log
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- Re-run 157's RLS discovery: it enables RLS and a tenant_isolation policy
-- (granted only to app_tenant) on every table carrying organization_id, so a
-- table that gained the column after 157 shipped — activity_log, here — is
-- covered without a second, hand-written policy to keep in sync with the
-- first. Idempotent by construction (ENABLE ROW LEVEL SECURITY and DROP
-- POLICY IF EXISTS both tolerate re-running), so tables 157 already covered
-- are untouched no-ops.
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
