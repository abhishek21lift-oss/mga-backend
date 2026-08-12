-- 148_staff_tables_rls.sql
--
-- `staff` and `staff_targets` are the only two tables in `public` with Row
-- Level Security switched off — the other 168 all have it on with a deny-all
-- policy. This closes that gap.
--
-- On the real exposure, so the next reader does not over- or under-react to the
-- Supabase advisor that flags this: the advisor's wording ("fully exposed to
-- anon and authenticated — anyone with the anon key can read or modify every
-- row") describes a default Supabase project. It does not describe this one.
-- This project revoked the blanket grants: `staff` and `staff_targets` grant
-- nothing at all to anon or authenticated, so PostgREST cannot reach them
-- regardless of RLS. Both tables are also empty. Nothing has leaked.
--
-- It is still worth fixing, for one specific reason. The protection today rests
-- entirely on the absence of a GRANT. Any future `GRANT ... ON ALL TABLES IN
-- SCHEMA public`, or a Supabase-side default-privilege change, would silently
-- make these two readable while the other 168 stayed protected by their
-- policies. RLS is the durable half of that pair; the grant is not.
--
-- Deny-all rather than tenant-scoped policies, matching every other table here
-- (see 130_admin_invitations.sql and 146_studio_registrations.sql). Worth being
-- explicit that this is the deliberate house pattern and not an oversight: the
-- API connects as the table owner, which bypasses RLS entirely, so all tenant
-- isolation is enforced in application SQL via tenantScope(). RLS exists here
-- purely to make the anon/authenticated client keys inert. There is not a
-- single organization_id-scoped policy in the database, and adding one here
-- would be the odd one out, not the fix.
--
-- Safe to apply while the app is running: it cannot lock out the backend, which
-- does not go through these roles.
--
-- ── Why every statement below is guarded on to_regclass ─────────────────────
--
-- These two tables do not exist on a database built from this repo. 030b
-- creates them, 064_drop_staff_module.sql drops them, and no tracked migration
-- ever creates them again — the `staff.sql` recorded in `_migrations` on the
-- live database is not a file in this repo, so the recreation happened out of
-- band.
--
-- Unguarded, `ALTER TABLE staff ENABLE ROW LEVEL SECURITY` therefore aborted a
-- fresh `npm run migrate` right here with
--
--     ERROR: 42P01: relation "staff" does not exist
--
-- (reproduced against a real Postgres, not assumed) and because migrate.js
-- stops on the first failure, migrations 149-154 never applied either. Anyone
-- standing up a new environment got a database silently six migrations behind,
-- and the error pointed at RLS rather than at the missing table.
--
-- 101_perf_fk_indexes_and_rls_initplan.sql hit exactly this with gym_settings
-- and solved it the same way; this matches that pattern deliberately.
--
-- Edited in place rather than shipped as a follow-up migration, because a
-- follow-up would run AFTER this file and so could never stop this file from
-- failing. migrate.js skips any filename already in `_migrations`, so on the
-- live database — where this migration is recorded as applied — the edit is
-- inert and re-applies nothing. On a fresh database it is the difference
-- between a working bootstrap and a broken one.
--
-- Both tables are empty and no application code references them, so if the
-- staff module stays retired the tidier end state is to drop them on the live
-- database and delete this file. That is a product decision, not a migration
-- fix, so it is left alone here.

DO $$
BEGIN
  IF to_regclass('public.staff') IS NOT NULL THEN
    ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON staff FROM anon, authenticated;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'staff'
         AND policyname = 'deny_all_direct_access'
    ) THEN
      CREATE POLICY deny_all_direct_access ON staff
        FOR ALL USING (false) WITH CHECK (false);
    END IF;
  END IF;

  IF to_regclass('public.staff_targets') IS NOT NULL THEN
    ALTER TABLE staff_targets ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON staff_targets FROM anon, authenticated;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'staff_targets'
         AND policyname = 'deny_all_direct_access'
    ) THEN
      CREATE POLICY deny_all_direct_access ON staff_targets
        FOR ALL USING (false) WITH CHECK (false);
    END IF;
  END IF;
END $$;
