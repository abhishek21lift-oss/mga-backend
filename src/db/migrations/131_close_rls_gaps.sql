-- ============================================================
-- 131_close_rls_gaps.sql
--
-- Closes finding C-01 of the production audit: 15 public tables
-- had Row Level Security DISABLED while the `anon` role held both
-- SELECT and INSERT on them.
--
-- Supabase exposes PostgREST at the project URL by default, so those
-- tables sat outside the Express API and outside every tenant check it
-- performs. Anyone holding the publishable key — a credential whose
-- entire design assumption is that it is public — could read every
-- studio's leads, the platform-only notes on support tickets, and the
-- email and IP of every login attempt. Writes were worse than reads:
-- platform_announcements was INSERTable, so a forged announcement would
-- reach every studio.
--
-- ── Why this is data-driven rather than a list of 15 ─────────────────
--
-- The 15 were an omission repeated across many separate commits over
-- months. A migration naming them would fix today's instances and teach
-- nothing. This converges EVERY table in `public` to the same standard,
-- so tables nobody has thought to check are covered too — including the
-- 140 that granted anon SELECT while relying on RLS alone to stop it.
--
-- The lasting fix is not this file. It is the test that ships with it
-- (__tests__/rls.convention.test.js), which fails the build when a new
-- migration creates a table without RLS. This file cleans up; the test
-- is what stops table number sixteen.
--
-- ── Why this cannot break the API ────────────────────────────────────
--
-- The application connects as `postgres`, which has usebypassrls = true.
-- RLS policies and anon/authenticated grants are invisible to it. The
-- proof is already in production: 144 tables carry deny-all policies
-- today, including users, organizations and pt_clients, and the app
-- reads them on every request.
--
-- Idempotent, and safe to re-run.
-- ============================================================

DO $$
DECLARE
  t  record;
  n  int := 0;
BEGIN
  FOR t IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind = 'r'
  LOOP
    -- 1. RLS on. With it enabled and no permissive policy matching, the
    --    default is deny — the policy below is belt to this braces.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.name);

    -- 2. No grants to the PostgREST roles. 140 tables granted anon
    --    SELECT; RLS was stopping it, but a grant that nothing needs is
    --    a dependency on exactly one control never being misconfigured.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.name);

    -- 3. An explicit deny, unless the table already carries one. Two
    --    older conventions exist in this schema — deny_all_anon +
    --    deny_all_authenticated on tables from the v4 era, and
    --    deny_all_direct_access on everything since migration 104. Both
    --    deny; neither is rewritten, because churning 144 working
    --    policies to make them cosmetically identical is risk with no
    --    security return.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t.name
         AND policyname IN ('deny_all_direct_access', 'deny_all_anon')
    ) THEN
      EXECUTE format(
        'CREATE POLICY deny_all_direct_access ON public.%I FOR ALL USING (false) WITH CHECK (false)',
        t.name);
      n := n + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '131_close_rls_gaps: added deny_all_direct_access to % table(s)', n;
END $$;

-- ── The four GUC policies ───────────────────────────────────────────
--
-- biometric_attendance, gym_settings, webauthn_challenges and
-- webauthn_credentials carried policies of the form
--
--     USING (member_id = current_setting('app.member_id', true)
--            OR current_setting('app.role', true) = 'admin')
--
-- granted to `public` FOR ALL. Nothing in the application sets either
-- GUC — verified by grep across src/ — so they were dead code. They
-- also denied by accident rather than by design: with the setting
-- absent, current_setting returns NULL, the comparison is NULL, and the
-- row is filtered. That is the right outcome reached the wrong way.
--
-- The failure mode is what makes them worth removing rather than
-- leaving: they hand FULL ACCESS to anyone who can get app.role set to
-- 'admin' on their session. webauthn_credentials holds authentication
-- material, so "probably nobody can set that GUC" is not the guarantee
-- that table should rest on.
--
-- Dropped, leaving the unconditional deny added above.
DROP POLICY IF EXISTS biometric_attendance_member_policy  ON public.biometric_attendance;
DROP POLICY IF EXISTS gym_settings_admin_policy           ON public.gym_settings;
DROP POLICY IF EXISTS webauthn_challenges_member_policy   ON public.webauthn_challenges;
DROP POLICY IF EXISTS webauthn_credentials_member_policy  ON public.webauthn_credentials;

-- Future tables created by a superuser default to no grants, but Supabase
-- ships default privileges that can re-grant to anon. Strip them so a
-- table created outside a migration does not arrive pre-exposed.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
