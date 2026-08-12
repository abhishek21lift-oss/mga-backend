-- ============================================================
-- 163_app_platform_role.sql
--
-- The third database tier: app_platform.
--
-- ── Why a third role exists ──────────────────────────────────────────
--
-- 157 gave the application one role, app_tenant, whose every policy is
-- an equality against app.org_id. That is exactly right for a tenant
-- request and useless for a platform one, because the Command Centre is
-- not scoped to an organisation — it lists all of them, aggregates
-- across all of them, and creates the first one out of nothing.
--
-- A platform super admin has organization_id NULL, so resolveOrgId
-- returns null, so pool.js sets no GUC at all. Under app_tenant that
-- silently means "no rows": GET /api/super-admin/registrations answers
-- 200 with an empty list while a pending application sits in the table,
-- and approval fails outright because organizations carries only the
-- deny-all policy from 131 and the inserts into trainers/users/
-- subscription_events all carry a brand-new organisation id that no
-- session context can match.
--
-- The alternatives were worse. Reusing `postgres` puts a table-owning
-- superuser-equivalent on the HTTP path. Granting app_tenant what the
-- platform needs would hand every tenant request cross-organisation
-- reach, which is the entire thing 157 exists to prevent. A GUC like
-- app.platform='on' would mean one leaked setting escalates from one
-- tenant to all of them — strictly worse than app.org_id, which leaks
-- only a single tenant, and the failure mode 131 had to clean up.
--
-- So: a separate login role, still NOBYPASSRLS, still NOSUPERUSER, with
-- an explicit allowlist and its own connection pool. It cannot be
-- reached from a tenant request because tenant requests use a different
-- pool with different credentials.
--
-- ── How the allowlist was derived ────────────────────────────────────
--
-- Not by judgement. Every SQL statement in the 16 super-admin modules
-- AND in the lib/ modules they call was parsed, and the table/operation
-- pairs below are what that found. The lib/ half matters: admin_invitations
-- is INSERTed in lib/invitations.js, not in any super-admin module, so an
-- inventory of the modules alone would have produced a role that cannot
-- invite an administrator.
--
-- SELECT is present wherever INSERT or UPDATE is, because 23 of those
-- statements use RETURNING, and PostgreSQL requires a SELECT policy to
-- hand back a row it just wrote. That is the same rule that made a plain
-- INSERT policy unusable for public registration in 162; it is not an
-- over-grant but a hard requirement of the statements the routes run.
--
-- DELETE appears on four tables only — the per-org AI limit and feature
-- overrides, announcements and coupons, all of which the console genuinely
-- removes. Every other table is denied it, including organizations and
-- users, which the platform can create and amend but never remove.
--
-- ── Why USING (true) ─────────────────────────────────────────────────
--
-- For the platform-global tables (platform_announcements, subscription_plans,
-- ai_model_rates …) "cross-organisation" is not even a concept: the rows
-- have no organisation. For the tenant-data tables (pt_clients, users,
-- attendance_logs …) reaching across organisations is precisely the
-- feature — a console that could only see one studio would not be a
-- platform console.
--
-- The narrowing is therefore in WHICH COMMANDS exist at all, not in a row
-- predicate: a table the inventory proves is only read gets a SELECT
-- policy and no other, so app_platform cannot write it even if a future
-- GRANT is widened by accident. Two independent controls have to fail.
--
-- studio_registrations is narrowed further, because there a real row
-- predicate exists — see below.
--
-- Idempotent, and safe to re-run.
-- ============================================================

-- ── The role ─────────────────────────────────────────────────────────
--
-- No password here. A password in a migration is a password in git
-- forever; scripts/provision-app-platform-password.js sets it from the
-- environment. Until it does, this role exists and cannot log in, which
-- is the safe order.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- Re-asserted, but only when something is actually wrong.
--
-- An unconditional ALTER ROLE here is a bootstrap-breaking bug, and this file
-- shipped with one. Naming SUPERUSER, REPLICATION or BYPASSRLS in ALTER ROLE —
-- even to switch them OFF — requires the executing role to be a superuser.
-- Supabase's `postgres` is not one: it holds CREATEROLE and no more, which is
-- enough to CREATE the role above with those attributes but not to re-state
-- them afterwards. So the statement failed with "permission denied to alter
-- role" and took the whole migration down with it, on the one database that
-- matters. It passed locally only because the workstation's postgres IS a
-- superuser — the same false-pass shape as the 131 gap, where a laxer local
-- server hid a failure that only production could show.
--
-- Reading first and writing only on a mismatch keeps the common paths free of
-- the privilege requirement: a fresh database gets its attributes from CREATE
-- ROLE above, and a correct existing role needs no statement at all. If a role
-- HAS drifted, the ALTER still runs and still fails loudly for a non-superuser,
-- which is the right outcome — that is a deliberate repair, not a bootstrap.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
    INTO r FROM pg_roles WHERE rolname = 'app_platform';

  IF NOT (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
          AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND NOT r.rolreplication) THEN
    RAISE NOTICE '163: app_platform attributes have drifted — repairing';
    ALTER ROLE app_platform WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- USAGE lets it resolve names in the schema. CREATE is revoked explicitly
-- rather than merely not granted, because PUBLIC has historically held
-- CREATE on public and an inherited grant would be invisible here.
GRANT USAGE ON SCHEMA public TO app_platform;
REVOKE CREATE ON SCHEMA public FROM app_platform;

-- Deliberately absent: ALTER DEFAULT PRIVILEGES. A table created by a
-- future migration must not become platform-readable merely by existing —
-- it has to be added to the list below, on purpose, with a reason.

DO $$
DECLARE
  r      record;
  op     text;
  polname text;
  granted int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- table                            operations         why platform needs it
      ('_migrations',                     'SELECT'),      -- ops dashboard shows applied schema version
      ('activity_log',                    'INSERT,SELECT'),-- every platform mutation is audited
      ('admin_invitations',               'INSERT,SELECT,UPDATE'), -- invite/resend/revoke a studio admin
      ('ai_model_rates',                  'INSERT,SELECT'),-- platform-set model pricing
      ('ai_platform_settings',            'SELECT,UPDATE'),-- global AI configuration
      ('ai_usage_log',                    'SELECT'),       -- cross-tenant AI spend reporting
      ('attendance_logs',                 'SELECT'),       -- platform engagement analytics
      ('founder_members',                 'INSERT,SELECT'),-- founder-pricing ledger
      ('login_events',                    'SELECT'),       -- security centre
      ('notifications',                   'INSERT,SELECT'),-- announcements fan out to tenants
      ('organization_ai_limits',          'DELETE,INSERT,SELECT'), -- per-org AI quota override
      ('organization_features',           'DELETE,INSERT,SELECT'), -- per-org feature toggles
      ('organizations',                   'INSERT,SELECT,UPDATE'), -- the hub: 14 of 16 modules
      ('plan_features',                   'INSERT,SELECT'),-- plan/feature matrix
      ('platform_ai_settings',            'SELECT,UPDATE'),-- AI control centre
      ('platform_announcements',          'DELETE,INSERT,SELECT,UPDATE'), -- authored by the platform
      ('platform_billing_settings',       'SELECT,UPDATE'),-- singleton payee/billing config
      ('platform_features',               'SELECT,UPDATE'),-- feature catalogue
      ('platform_payment_settings',       'INSERT,SELECT'),-- checkout configuration
      ('pt_clients',                      'SELECT'),       -- tenant analytics, read-only
      ('pt_sessions',                     'SELECT'),       -- tenant analytics, read-only
      ('refresh_tokens',                  'SELECT,UPDATE'),-- forced session revocation
      ('storage_accounting_meta',         'SELECT'),       -- storage billing
      ('storage_objects',                 'SELECT'),       -- storage billing
      ('studio_registrations',            'SELECT,UPDATE'),-- the approval queue
      ('subscription_coupon_redemptions', 'INSERT,SELECT,UPDATE'),
      ('subscription_coupons',            'DELETE,INSERT,SELECT,UPDATE'),
      ('subscription_events',             'INSERT,SELECT'),-- trial/plan lifecycle audit
      ('subscription_invoices',           'INSERT,SELECT,UPDATE'),
      ('subscription_payment_requests',   'INSERT,SELECT,UPDATE'),
      ('subscription_payments',           'INSERT,SELECT,UPDATE'),
      ('subscription_plans',              'SELECT'),       -- plan catalogue, platform-managed
      ('support_ticket_messages',         'INSERT,SELECT'),-- operator replies
      ('support_tickets',                 'SELECT,UPDATE'),-- triage across tenants
      ('trainers',                        'INSERT,SELECT'),-- created during provisioning
      ('trials',                          'SELECT'),
      ('user_profiles',                   'SELECT,UPDATE'),
      ('users',                           'INSERT,SELECT,UPDATE') -- owner creation; never DELETE
    ) AS t(tbl, ops)
  LOOP
    -- Skipped rather than fatal: this file must survive a fresh bootstrap
    -- where a later migration has not yet created one of these tables.
    CONTINUE WHEN to_regclass('public.' || quote_ident(r.tbl)) IS NULL;

    EXECUTE format('GRANT %s ON public.%I TO app_platform', r.ops, r.tbl);

    FOREACH op IN ARRAY string_to_array(r.ops, ',')
    LOOP
      polname := 'platform_' || lower(op);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', polname, r.tbl);

      IF op = 'SELECT' THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO app_platform USING (true)', polname, r.tbl);

      ELSIF op = 'INSERT' THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR INSERT TO app_platform WITH CHECK (true)', polname, r.tbl);

      ELSIF op = 'UPDATE' THEN
        -- The one table where a genuine row predicate exists. An application
        -- may only be reviewed while it is still pending, which is the same
        -- invariant approveHandler and rejectHandler check in JavaScript
        -- before they write. Enforcing it here too closes the window between
        -- their check and their UPDATE: two operators approving the same
        -- application concurrently cannot both win.
        IF r.tbl = 'studio_registrations' THEN
          EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO app_platform '
            'USING (status = ''pending'') WITH CHECK (true)', polname, r.tbl);
        ELSE
          EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO app_platform '
            'USING (true) WITH CHECK (true)', polname, r.tbl);
        END IF;

      ELSIF op = 'DELETE' THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR DELETE TO app_platform USING (true)', polname, r.tbl);
      END IF;
    END LOOP;

    granted := granted + 1;
  END LOOP;

  RAISE NOTICE '163_app_platform_role: configured % table(s) for app_platform', granted;
END $$;

-- ── Sequences ────────────────────────────────────────────────────────
--
-- Exactly one, and not because a column defaults to nextval — none of the
-- allowlisted tables do. trainers carries a trigger, assign_trn_unique_id,
-- which builds the human-facing 'TRN-00042' identifier from seq_trn_id. A
-- trigger function runs as the invoking role unless it is SECURITY DEFINER,
-- and this one is not, so the platform role needs the sequence to create a
-- trainer during studio provisioning.
--
-- Found the way these things should be found: the approval transaction
-- failed with "permission denied for sequence seq_trn_id" against a real
-- app_platform connection. An inventory built only from column defaults
-- missed it, because the reference is inside a trigger body.
--
-- USAGE only — enough for nextval and currval, not for setval, so the
-- platform role cannot rewind or skip the counter.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'seq_trn_id') THEN
    EXECUTE 'GRANT USAGE ON SEQUENCE public.seq_trn_id TO app_platform';
  END IF;
END $$;

-- Public registration stays on its own path. app_platform is not granted
-- EXECUTE on platform_submit_studio_registration: that function exists so
-- an ANONYMOUS caller on the tenant pool can cross the pre-tenant boundary,
-- and the platform pool has no anonymous callers. Granting it here would
-- widen the function's reach for no route that needs it.
