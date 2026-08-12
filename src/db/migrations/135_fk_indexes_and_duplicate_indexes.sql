-- ============================================================
-- 135_fk_indexes_and_duplicate_indexes.sql
--
-- Audit finding H-04. Two performance defects that both get strictly
-- harder to fix as the platform grows:
--
--   1. 29 foreign keys with no covering index.
--   2. 17 pairs of redundant indexes.
--
-- This is the same class of work migration 101 did at the 14-FK mark.
-- Everything below arrived in the 34 migrations since, so this is not a
-- re-fix of 101 — it is the tables added after it. Verified against the
-- live schema (pg_constraint / pg_index) rather than trusting the
-- advisor's list, which is how the count came out at 17 duplicate pairs
-- instead of the 5 the advisor reports; it only flags same-uniqueness
-- twins, and misses a plain index shadowed by a UNIQUE one.
--
-- ── Why the FK indexes matter, concretely ───────────────────────────
--
-- Postgres indexes the REFERENCED side of a foreign key automatically —
-- it has to, since the target must be unique. It never indexes the
-- REFERENCING side. So every time a parent row is deleted or its key
-- updated, Postgres must prove no child still points at it, and with no
-- index that proof is a sequential scan of the whole child table.
--
-- Deleting one studio currently means a full scan of login_events and
-- ai_document_chunks — the two tables that grow fastest and without
-- bound. Same for a plan code: `plan_code` is referenced by
-- subscription_payment_requests, subscription_coupon_redemptions and
-- subscription_payments, none of them indexed, so retiring a plan scans
-- all three. And the same indexes serve the ordinary joins the Control
-- Centre already does (support tickets by author, payments by
-- submission), which today are hash joins over the full table.
--
-- ── Why plain CREATE INDEX and not CONCURRENTLY ─────────────────────
--
-- src/db/migrate.js wraps every migration file in BEGIN/COMMIT, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. This
-- is the same constraint 101 documented. The tables are small enough
-- that the ACCESS EXCLUSIVE lock is a few milliseconds during a deploy
-- that is already restarting the process.
--
-- When that stops being true — roughly when login_events or
-- ai_document_chunks passes a few hundred thousand rows — the index has
-- to be built by hand outside the migration runner:
--
--     CREATE INDEX CONCURRENTLY idx_foo_bar ON foo (bar);
--
-- and then added here as IF NOT EXISTS so a rebuilt database still gets
-- it. Doing it now would need migrate.js to learn a non-transactional
-- mode, which is a change to the boot path for no present benefit.
--
-- ── Why dropping the duplicates is safe ─────────────────────────────
--
-- A redundant index is not free: it is written on every INSERT and
-- UPDATE of the table, it competes for the same buffer cache, and it
-- doubles the work autovacuum does on that table. Two indexes over the
-- same columns can never both be needed — the planner picks one.
--
-- 12 of the 17 pairs are a plain index sitting behind a UNIQUE index on
-- the same columns. A unique btree answers every lookup a non-unique
-- btree over the same key answers, so the plain one is dead weight. But
-- 11 of those UNIQUE indexes BACK A CONSTRAINT (primary key or unique
-- constraint), and dropping such an index drops the constraint with it.
-- So in every one of those pairs this file drops the NON-constraint
-- twin, named explicitly, never the generated `*_key` / `*_pkey`.
--
-- The exception worth calling out is users(lower(email)):
-- users_email_lower_idx is UNIQUE but backs no constraint, because an
-- expression index cannot. It is nonetheless the one that must survive
-- — it is what makes case-insensitive login unambiguous, and login
-- itself is `LOWER(u.email) = LOWER($1)`. The plain twin is dropped.
--
-- The remaining 5 pairs are two plain indexes with identical
-- definitions; either could go, and the newer `idx_*` name is kept for
-- the two on activity_log where the survivor is the one written by a
-- migration rather than by hand, and dropped elsewhere for the same
-- reason. Each drop is IF NOT EXISTS-guarded by name, so a database
-- that never had the twin is unaffected.
--
-- Nothing here changes query results. ON CONFLICT resolves by column
-- list rather than index name, and every UNIQUE constraint survives, so
-- no upsert in the codebase can be affected by a rename or a drop.
--
-- Idempotent, and safe to re-run.
-- ============================================================

-- ── 1. Covering indexes for the 29 unindexed foreign keys ───────────
--
-- One per referencing column, in table order. Named idx_<table>_<column>
-- to match 101 and the rest of the schema.

-- Fastest-growing tables first: these are the scans that hurt today.
CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_organization_id
  ON public.ai_document_chunks (organization_id);

CREATE INDEX IF NOT EXISTS idx_login_events_organization_id
  ON public.login_events (organization_id);

CREATE INDEX IF NOT EXISTS idx_ai_documents_uploaded_by
  ON public.ai_documents (uploaded_by);

CREATE INDEX IF NOT EXISTS idx_membership_payments_approved_by
  ON public.membership_payments (approved_by);

CREATE INDEX IF NOT EXISTS idx_membership_payments_submission_id
  ON public.membership_payments (submission_id);

CREATE INDEX IF NOT EXISTS idx_organizations_pending_plan_code
  ON public.organizations (pending_plan_code);

CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_actor_id
  ON public.payment_audit_logs (actor_id);

CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_submission_id
  ON public.payment_audit_logs (submission_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_created_by
  ON public.payment_orders (created_by);

CREATE INDEX IF NOT EXISTS idx_payment_orders_plan_id
  ON public.payment_orders (plan_id);

CREATE INDEX IF NOT EXISTS idx_payment_submissions_submitted_by
  ON public.payment_submissions (submitted_by);

CREATE INDEX IF NOT EXISTS idx_payment_submissions_verified_by
  ON public.payment_submissions (verified_by);

CREATE INDEX IF NOT EXISTS idx_plan_features_feature_key
  ON public.plan_features (feature_key);

CREATE INDEX IF NOT EXISTS idx_platform_payment_settings_updated_by
  ON public.platform_payment_settings (updated_by);

CREATE INDEX IF NOT EXISTS idx_pt_leads_converted_client_id
  ON public.pt_leads (converted_client_id);

CREATE INDEX IF NOT EXISTS idx_revenue_targets_set_by
  ON public.revenue_targets (set_by);

CREATE INDEX IF NOT EXISTS idx_storage_objects_uploaded_by
  ON public.storage_objects (uploaded_by);

CREATE INDEX IF NOT EXISTS idx_subscription_coupon_redemptions_payment_id
  ON public.subscription_coupon_redemptions (payment_id);

CREATE INDEX IF NOT EXISTS idx_subscription_coupon_redemptions_plan_code
  ON public.subscription_coupon_redemptions (plan_code);

CREATE INDEX IF NOT EXISTS idx_subscription_coupons_created_by
  ON public.subscription_coupons (created_by);

-- subscription_payment_requests carries six unindexed foreign keys — the
-- most of any table here. It is also the table the plan-change flow
-- writes on every upgrade, so it is the one where the extra write cost
-- of six indexes is most worth stating: six btree inserts per row, on a
-- table that sees a handful of rows a day.
CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_created_by
  ON public.subscription_payment_requests (created_by);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_payment_id
  ON public.subscription_payment_requests (payment_id);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_plan_code
  ON public.subscription_payment_requests (plan_code);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_previous_plan_code
  ON public.subscription_payment_requests (previous_plan_code);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_reviewed_by
  ON public.subscription_payment_requests (reviewed_by);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_requests_submitted_by
  ON public.subscription_payment_requests (submitted_by);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_previous_plan_code
  ON public.subscription_payments (previous_plan_code);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_author_id
  ON public.support_ticket_messages (author_id);

CREATE INDEX IF NOT EXISTS idx_support_tickets_created_by
  ON public.support_tickets (created_by);

-- ── 2a. Redundant plain indexes shadowed by a UNIQUE index ──────────
--
-- In each pair below the surviving index is UNIQUE over the same
-- columns, so it answers every lookup the dropped one did. Eleven of
-- the survivors back a primary key or unique constraint and MUST NOT be
-- touched; the twelfth (users_email_lower_idx) enforces
-- case-insensitive email uniqueness by itself. Only the redundant twin
-- is named here.

-- keeps admin_reset_intents_admin_id_action_key (unique constraint)
DROP INDEX IF EXISTS public.idx_admin_reset_intents_admin;

-- keeps client_fitness_profiles_client_id_key (unique constraint)
DROP INDEX IF EXISTS public.cfp_client_idx;

-- keeps feature_flags_pkey (primary key)
DROP INDEX IF EXISTS public.feature_flags_key_idx;

-- keeps offers_code_key (unique constraint)
DROP INDEX IF EXISTS public.idx_offers_code;

-- keeps pt_payouts_trainer_id_month_key (unique constraint)
DROP INDEX IF EXISTS public.pt_payouts_trainer_idx;

-- keeps qr_tokens_token_key (unique constraint)
DROP INDEX IF EXISTS public.idx_qr_token;

-- keeps subscription_invoices_invoice_number_key (unique constraint)
DROP INDEX IF EXISTS public.idx_sub_invoices_number;

-- keeps system_settings_pkey (primary key)
DROP INDEX IF EXISTS public.system_settings_key_idx;

-- keeps user_webauthn_credentials_credential_id_key (unique constraint)
DROP INDEX IF EXISTS public.idx_user_webauthn_creds_credential_id;

-- keeps users_email_key (unique constraint)
DROP INDEX IF EXISTS public.idx_users_email;

-- keeps users_email_lower_idx — UNIQUE, backs no constraint (an
-- expression index cannot), and is what makes LOWER(email) login
-- unambiguous. Dropping the wrong one of this pair would silently allow
-- two accounts differing only in case.
DROP INDEX IF EXISTS public.idx_users_email_lower;

-- keeps webauthn_credentials_credential_id_key (unique constraint)
DROP INDEX IF EXISTS public.idx_webauthn_credentials_credential_id;

-- ── 2b. Exact-duplicate plain indexes ───────────────────────────────
--
-- Identical definitions, neither unique, neither constraint-backed, so
-- the choice of survivor is arbitrary. Kept the name a migration wrote
-- rather than the older hand-made one, so the schema matches the files.

-- activity_log (created_at DESC): keep idx_activity_log_created_at
DROP INDEX IF EXISTS public.actlog_date_idx;

-- activity_log (user_id, created_at DESC): keep idx_activity_log_user_created
DROP INDEX IF EXISTS public.actlog_user_idx;

-- invoices (client_id): keep idx_invoices_client
DROP INDEX IF EXISTS public.invoices_client_id_idx;

-- pt_assessments (client_id): keep idx_pt_assessments_client
DROP INDEX IF EXISTS public.pt_assessments_client_idx;

-- pt_payments (client_id): keep idx_pt_payments_client
DROP INDEX IF EXISTS public.pt_payments_client_idx;

-- ── 3. Refresh planner statistics on the touched tables ─────────────
--
-- New indexes do not carry statistics until something gathers them, and
-- autovacuum will not visit a table that has had no writes. Without
-- this the planner can keep choosing the sequential scan for hours
-- after the index exists, which reads as "the migration did nothing".
-- ANALYZE is cheap on tables this size and holds only a SHARE UPDATE
-- EXCLUSIVE lock, which does not block reads or writes.
ANALYZE public.ai_document_chunks;
ANALYZE public.login_events;
ANALYZE public.subscription_payment_requests;
