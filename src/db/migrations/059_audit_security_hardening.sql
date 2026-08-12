-- 059_audit_security_hardening.sql
-- Production audit remediation (findings C1 / H1 / H3 / M5).
-- Applied to the live database via Supabase migration `audit_security_hardening_rls`.
--
-- Context: the app talks only to the Express backend (JWT), never to the Supabase
-- Data API (PostgREST). The backend connects with a role that bypasses RLS, so
-- enabling RLS + a deny-all policy for anon/authenticated closes the Data-API hole
-- without affecting backend access. This mirrors the existing pt_clients convention.

-- C1 / H3: enable Row Level Security + deny direct anon/authenticated access
-- on the seven previously-unprotected public tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_webauthn_credentials','pt_lifestyle_assessments',
    'pt_mobility_performance_assessments','pt_nutrition_assessments',
    'pt_posture_assessments','agent_tasks','agent_audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format('CREATE POLICY deny_all_direct_access ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;

-- H1: the trainer earnings view should honour the caller's permissions.
ALTER VIEW public.v_trainer_monthly_earnings SET (security_invoker = on);

-- M5: pin a stable search_path on the updated_at trigger helper (body only calls NOW()).
ALTER FUNCTION public.set_updated_at() SET search_path = '';
