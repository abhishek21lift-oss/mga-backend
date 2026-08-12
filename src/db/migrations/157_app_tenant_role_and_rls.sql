-- 157_app_tenant_role_and_rls.sql
-- Database-level tenant isolation — the design verified in
-- TENANT-RLS-PLAN.md, landed as infrastructure that is INERT until two
-- further, non-database steps happen (see that doc's "why this cannot ship
-- as a migration alone" and "rollout order" sections):
--
--   1. DATABASE_URL has to be switched from the `postgres` role to
--      `app_tenant`, created below. Until that happens, the API keeps
--      connecting as `postgres`, which is the table owner and has
--      BYPASSRLS — every policy this migration adds is invisible to it.
--      Enabling RLS on a table does NOT affect a role that owns the table
--      or has BYPASSRLS, so applying this migration to production changes
--      nothing observable for the app as it runs today.
--   2. The app has to set `app.org_id` per request (the AsyncLocalStorage
--      plumbing in db/pool.js, itself off by default behind
--      TENANT_RLS_ENFORCE) — a role connected without that GUC set matches
--      no policy below and, once connected as app_tenant, would see zero
--      rows on every strict tenant table. Fail-closed, not fail-open.
--
-- So: safe to apply now, does nothing on its own, is the second half of a
-- three-part rollout (role + policies here; app-side enforcement flag in
-- pool.js; the actual DATABASE_URL cutover as a deployment step on a tested
-- staging branch first, per the rollout order in TENANT-RLS-PLAN.md).

-- The role the app will eventually connect as. LOGIN so it can be used as a
-- connection role; deliberately NOT superuser and NOT BYPASSRLS — that is
-- the entire point of this role existing. No password is set here — a
-- migration file is version-controlled, and a role's password does not
-- belong in it. Set one out of band (Supabase SQL editor or equivalent)
-- before pointing any DATABASE_URL at this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Table/sequence/function privileges. Broad on purpose: TENANT-RLS-PLAN.md
-- is explicit that fine-tuning happens against a staging branch ("fix every
-- permission error that surfaces — this is the step that finds what the app
-- quietly relied on"), not by trying to enumerate 839 call sites' exact
-- needs up front. RLS policies (below) are the actual isolation boundary;
-- these grants only decide what app_tenant may attempt, same as `postgres`
-- could attempt today.
GRANT USAGE ON SCHEMA public TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_tenant;

-- One policy per table carrying organization_id, discovered from the schema
-- itself rather than a hand-maintained list — the same reasoning
-- tenantScope.convention.test.js uses for its own table list, so a tenant
-- table added after this migration ships is covered automatically instead
-- of silently missing a policy.
--
-- Two shapes (verified against production in TENANT-RLS-PLAN.md):
--   - Strict: organization_id must match the connection's app.org_id.
--   - Shared: also allows organization_id IS NULL, for the handful of
--     tables that mix org-owned rows with platform-global content
--     (the shared exercise library, diet templates, reference landmarks,
--     unattributed failed logins, the org-less platform super-admin, and
--     workout/storage/webauthn tables where org-owned and shared rows
--     coexist). This list is intentionally identical to SHARED_TABLES in
--     migrations.orgNotNull.test.js — same question ("does this table have
--     legitimate NULL organization_id rows?"), so a second, independent
--     answer here would only be a second place for the two to drift apart.
--     A dedicated test cross-checks the two stay identical.
--
-- Granted ONLY to app_tenant, per the GUC caution in TENANT-RLS-PLAN.md:
-- migration 131 had to drop policies that were granted to `public` with
-- nothing setting the GUC, which denied by accident and handed everything
-- to anyone who *could* set it. These policies never touch `public`,
-- `anon`, or `authenticated`, and the existing deny-all policies for those
-- roles are untouched.
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
