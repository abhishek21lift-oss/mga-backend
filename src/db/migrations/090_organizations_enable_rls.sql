-- 090_organizations_enable_rls.sql
-- Phase 1 (RLS hardening). The organizations table (created in 078) was the
-- only public table left with RLS disabled — the Supabase security advisor
-- flags it ERROR-level (rls_disabled_in_public), and it means the tenant list
-- (every org's name/slug) is readable via the auto-generated PostgREST API by
-- the anon/authenticated roles, bypassing the Express app entirely.
--
-- Every other app table already carries a deny-all RLS policy for anon +
-- authenticated (USING (false)); this brings organizations in line with that
-- convention. The Express backend connects as the `postgres` role, which has
-- BYPASSRLS, so it is unaffected — this only closes the direct-API path.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Deny the PostgREST API roles outright. No permissive allow policy exists, so
-- anon/authenticated see zero rows; postgres/service_role bypass RLS entirely.
DROP POLICY IF EXISTS deny_all_direct_access ON organizations;
CREATE POLICY deny_all_direct_access ON organizations
  AS PERMISSIVE FOR ALL
  TO anon, authenticated
  USING (false);
