-- 061_audit_lock_anon_rpc.sql
-- Production audit remediation (H1 / remaining Warn-level RPC exposure).
-- Applied to the live database via Supabase migration `audit_lock_anon_rpc_functions`.
--
-- The four current_* helpers are SECURITY DEFINER functions used only by RLS
-- internally; the backend never calls them and connects as postgres/service_role
-- (which retain their explicit EXECUTE grants). Revoking from PUBLIC (the anon
-- path) and authenticated stops them being invoked via /rest/v1/rpc from the
-- Supabase Data API. After this, the security advisor reports only the three
-- (low-risk) extension-in-public warnings, which are intentionally left in place
-- because relocating pg_trgm/vector/unaccent would risk breaking fuzzy search
-- and vector indexes on the live database.
-- Guarded per function. As the note above says, these were created through
-- Supabase's own migration system rather than this directory, so they exist on
-- the live database but on no database built from this repo — where the bare
-- REVOKE then aborted the migration. Skipping a revoke for a function that
-- does not exist grants nothing: there is no function to call.
DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'current_user_id', 'current_user_role', 'current_member_id', 'current_branch_id'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = fn AND p.pronargs = 0
    ) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, authenticated', fn);
    END IF;
  END LOOP;
END $$;
