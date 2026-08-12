-- 101_perf_fk_indexes_and_rls_initplan.sql
-- Performance hygiene from the Supabase linter (performance advisors).
--
-- Three groups, all low-risk:
--   1. 14 foreign keys with no covering index — every ON DELETE/UPDATE and
--      every join across them degrades to a sequential scan.
--   2. One duplicate index on exercises (verified identical definition and
--      not constraint-backed before dropping).
--   3. Four RLS policies that re-evaluate current_setting() per row. Wrapping
--      the call in a scalar subquery makes Postgres hoist it into an InitPlan
--      so it is evaluated once per query rather than once per row. Semantics
--      are unchanged — same expression, same roles, same USING/WITH CHECK.
--
-- Note: indexes are created without CONCURRENTLY because src/db/migrate.js
-- runs each migration inside a transaction (CONCURRENTLY is not permitted
-- there). These tables are small; the exclusive lock is momentary.
--
-- Deliberately NOT addressed here: the linter's 232 "unused index" warnings.
-- At current data volumes no index registers usage, so those are noise.
-- Re-run the advisor against real production traffic before dropping any.

-- ── 1. Covering indexes for unindexed foreign keys ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_tasks_conversation_id
  ON public.agent_tasks (conversation_id);

CREATE INDEX IF NOT EXISTS idx_founder_members_plan_code
  ON public.founder_members (plan_code);

CREATE INDEX IF NOT EXISTS idx_organizations_plan_code
  ON public.organizations (plan_code);

CREATE INDEX IF NOT EXISTS idx_pt_informed_consents_created_by
  ON public.pt_informed_consents (created_by);

CREATE INDEX IF NOT EXISTS idx_pt_informed_consents_trainer_id
  ON public.pt_informed_consents (trainer_id);

CREATE INDEX IF NOT EXISTS idx_pt_medical_clearances_reviewed_by
  ON public.pt_medical_clearances (reviewed_by);

CREATE INDEX IF NOT EXISTS idx_pt_parq_documents_uploaded_by
  ON public.pt_parq_documents (uploaded_by);

CREATE INDEX IF NOT EXISTS idx_pt_parq_forms_created_by
  ON public.pt_parq_forms (created_by);

CREATE INDEX IF NOT EXISTS idx_subscription_invoices_payment_id
  ON public.subscription_invoices (payment_id);

CREATE INDEX IF NOT EXISTS idx_subscription_invoices_plan_code
  ON public.subscription_invoices (plan_code);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_plan_code
  ON public.subscription_payments (plan_code);

CREATE INDEX IF NOT EXISTS idx_workout_sessions_created_by
  ON public.workout_sessions (created_by);

CREATE INDEX IF NOT EXISTS idx_workout_sessions_trainer_id
  ON public.workout_sessions (trainer_id);

CREATE INDEX IF NOT EXISTS idx_workout_sessions_workout_assignment_id
  ON public.workout_sessions (workout_assignment_id);

-- ── 2. Drop the duplicate index on exercises ────────────────────────────────
-- exercises_body_part_idx and idx_exercises_body_part are both
-- `btree (body_part)`; neither backs a constraint. Keep the former.
DROP INDEX IF EXISTS public.idx_exercises_body_part;

-- ── 3. InitPlan-cache the per-row current_setting() calls ───────────────────
-- Each policy below is recreated with identical logic, differing only in that
-- current_setting(...) is wrapped in (SELECT ...).
-- gym_settings is the one table in this block that no tracked migration
-- creates — it exists on the live database only because it was created out of
-- band. DROP POLICY IF EXISTS still errors when the TABLE is missing, so this
-- aborted a fresh database. Every other table policed below is created by this
-- repo and needs no guard.
DO $$ BEGIN
  IF to_regclass('public.gym_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS gym_settings_admin_policy ON public.gym_settings;
    CREATE POLICY gym_settings_admin_policy ON public.gym_settings
      FOR ALL
      USING ((SELECT current_setting('app.role', true)) = 'admin')
      WITH CHECK ((SELECT current_setting('app.role', true)) = 'admin');
  END IF;
END $$;

DROP POLICY IF EXISTS webauthn_credentials_member_policy ON public.webauthn_credentials;
CREATE POLICY webauthn_credentials_member_policy ON public.webauthn_credentials
  FOR ALL
  USING (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  )
  WITH CHECK (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  );

DROP POLICY IF EXISTS webauthn_challenges_member_policy ON public.webauthn_challenges;
CREATE POLICY webauthn_challenges_member_policy ON public.webauthn_challenges
  FOR ALL
  USING (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  )
  WITH CHECK (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  );

DROP POLICY IF EXISTS biometric_attendance_member_policy ON public.biometric_attendance;
CREATE POLICY biometric_attendance_member_policy ON public.biometric_attendance
  FOR ALL
  USING (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  )
  WITH CHECK (
    member_id = (SELECT current_setting('app.member_id', true))
    OR (SELECT current_setting('app.role', true)) = 'admin'
  );
