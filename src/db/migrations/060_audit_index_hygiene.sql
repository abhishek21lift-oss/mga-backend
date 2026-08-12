-- 060_audit_index_hygiene.sql
-- Production audit remediation (findings M1 / M2).
-- Applied to the live database via Supabase migration `audit_index_hygiene`.

-- M1: add covering indexes for foreign keys that lacked one (faster joins/deletes).
CREATE INDEX IF NOT EXISTS idx_automation_rules_created_by ON public.automation_rules(created_by);
CREATE INDEX IF NOT EXISTS idx_communication_logs_automation_rule_id ON public.communication_logs(automation_rule_id);
CREATE INDEX IF NOT EXISTS idx_progress_photos_uploaded_by ON public.progress_photos(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_pt_assessments_created_by ON public.pt_assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_pt_commissions_client_id ON public.pt_commissions(client_id);
CREATE INDEX IF NOT EXISTS idx_pt_goals_created_by ON public.pt_goals(created_by);
CREATE INDEX IF NOT EXISTS idx_pt_lifestyle_assessments_created_by ON public.pt_lifestyle_assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_pt_mobility_perf_assessments_created_by ON public.pt_mobility_performance_assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_pt_nutrition_assessments_created_by ON public.pt_nutrition_assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_pt_payouts_processed_by ON public.pt_payouts(processed_by);
CREATE INDEX IF NOT EXISTS idx_pt_posture_assessments_created_by ON public.pt_posture_assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_trial_sessions_created_by ON public.trial_sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_weekly_checkins_created_by ON public.weekly_checkins(created_by);

-- M2: drop the redundant twin of each identical index pair
-- (all verified non-unique and not backing a constraint before removal).
DROP INDEX IF EXISTS public.att_date_reftype_idx;
DROP INDEX IF EXISTS public.idx_biometric_attendance_member;
DROP INDEX IF EXISTS public.clients_trainer_idx;
DROP INDEX IF EXISTS public.face_log_client_idx;
DROP INDEX IF EXISTS public.face_log_date_idx;
DROP INDEX IF EXISTS public.mm_member_idx;
DROP INDEX IF EXISTS public.mm_status_idx;
DROP INDEX IF EXISTS public.idx_payments_branch;
DROP INDEX IF EXISTS public.idx_payments_client;
DROP INDEX IF EXISTS public.pa_client_idx;
DROP INDEX IF EXISTS public.idx_pt_subs_client_id;
DROP INDEX IF EXISTS public.pg_client_idx;
DROP INDEX IF EXISTS public.pts_date_idx;
DROP INDEX IF EXISTS public.referrals_referred_idx;
DROP INDEX IF EXISTS public.idx_refresh_user;
DROP INDEX IF EXISTS public.users_active_idx;
DROP INDEX IF EXISTS public.idx_webauthn_credentials_member;
