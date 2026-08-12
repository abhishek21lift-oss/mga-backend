-- 100_subscription_tables_enable_rls.sql
-- Closes the RLS gap introduced by 099_subscription_foundation.sql.
--
-- Context: 059_audit_security_hardening.sql and 090_organizations_enable_rls.sql
-- established the convention that every public table carries a deny-all RLS
-- policy for the PostgREST roles (anon / authenticated), so the Supabase Data
-- API cannot reach app data even though those roles hold table grants. 125 of
-- 130 tables followed it; the five tables added by 099 did not.
--
-- Verified before this migration: all five had relrowsecurity = false, zero
-- policies, and anon/authenticated holding SELECT+INSERT+UPDATE+DELETE+TRUNCATE.
-- Supabase's linter flagged each one ERROR-level (rls_disabled_in_public,
-- facing EXTERNAL). The exposure was write-capable, not just readable —
-- subscription_plans drives the 402 SUBSCRIPTION_INACTIVE billing gate.
--
-- The Express backend connects as a BYPASSRLS role, so this is transparent to
-- the application. It only closes the direct Data-API path.
--
-- Idempotent: safe to re-run, and safe to apply out of band (e.g. via the
-- Supabase migration path) and then again through src/db/migrate.js.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscription_plans',
    'subscription_payments',
    'subscription_invoices',
    'subscription_events',
    'founder_members'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated '
      'USING (false) WITH CHECK (false)', t);

    -- Defence in depth: the deny-all policy is what actually blocks access,
    -- but there is no reason for the Data-API roles to hold DML grants on
    -- billing tables at all. Revoking removes the second half of the hole.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
