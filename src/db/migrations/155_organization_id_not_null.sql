-- 155_organization_id_not_null.sql
--
-- Audit finding H-5. Every table that had organization_id retrofitted onto it
-- (migrations 079-097, 143) got it NULLABLE and was never tightened, while every
-- table designed multi-tenant from birth (099 onward) declares it
-- `UUID NOT NULL REFERENCES organizations(id)` at CREATE TABLE time.
--
-- The tables carrying the bulk of the business data are all on the wrong side of
-- that split. The consequence is not a cross-tenant leak — tenantScope() filters
-- `organization_id = $orgId`, and NULL matches nothing — it is SILENT DATA LOSS
-- from the tenant's point of view. A write path that fails to stamp the column
-- produces a row that belongs to nobody: invisible in every studio's queries,
-- present in the table, and reported to the caller as a success. A NOT NULL
-- constraint converts that from an invisible orphan into a rejected write at the
-- point the bug happens.
--
-- ── Why this migration checks before it tightens ────────────────────────────
--
-- Migrations now run as part of the deploy (H-2), and `migrate.js` aborts the
-- whole run on the first failure. A bare `ALTER TABLE ... SET NOT NULL` against
-- a table that happens to hold one orphaned row would therefore take the deploy
-- down — turning a data-quality issue into an outage, on a schema change whose
-- entire purpose is to make data quality visible.
--
-- So each table is tightened ONLY if it currently holds zero NULLs, and skipped
-- with a warning otherwise. That makes this file safe to apply to any
-- environment without inspecting it first, and safe to re-run: a table skipped
-- today because it had an orphan can be tightened by re-running once the orphan
-- is fixed. It is idempotent — already-NOT NULL columns are left alone.
--
-- ── What is deliberately NOT in the list ────────────────────────────────────
--
-- Tables whose NULLs are MEANINGFUL, verified by row counts on the live
-- database rather than assumed:
--
--   exercises                 890 rows, all NULL — the shared exercise library
--                             every studio draws from. Tightening this would
--                             require inventing an owner for platform content.
--   diet_templates            shared templates, same reasoning
--   muscle_volume_landmarks   reference data
--   login_events              NULL for failed attempts where no user was
--                             identified yet, so there was no org to record
--   users                     the platform super_admin has no organization by
--                             design; that is what makes them cross-tenant
--   workout_plans             holds both org-owned and shared template plans
--   storage_objects,          platform-level rows exist alongside tenant ones
--   user_webauthn_credentials
--
-- For those, NULL means "belongs to the platform", not "we forgot". Tightening
-- them would be the bug rather than the fix.

DO $$
DECLARE
  t            TEXT;
  null_count   BIGINT;
  tightened    INT := 0;
  skipped      INT := 0;
  already      INT := 0;

  -- Tenant-owned tables only. Every one of these was verified to hold zero
  -- NULL organization_id rows on production before being listed here; the
  -- per-table guard below re-checks anyway, because this file will run against
  -- environments whose data nobody has looked at.
  targets TEXT[] := ARRAY[
    'pt_clients', 'pt_payments', 'pt_sessions', 'pt_assessments', 'pt_goals',
    'pt_leads', 'pt_informed_consents', 'pt_parq_forms', 'pt_parq_documents',
    'pt_medical_clearances', 'pt_consent_records',
    'attendance_logs', 'trainers', 'invoices', 'expenses',
    'progress_photos', 'weekly_checkins', 'strength_logs', 'nutrition_logs',
    'client_invitations', 'client_fitness_profiles', 'communication_history',
    'diet_assignments', 'workout_assignments', 'workout_sessions',
    'user_portfolio_items', 'ai_action_plans', 'subscription_events'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    -- Not every environment has every table (the schema grew over 154
    -- migrations and some tables arrived late), so a missing one is skipped
    -- rather than fatal — same reasoning as the to_regclass guards in 101/148.
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    -- Already NOT NULL: nothing to do. Keeps the migration re-runnable.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t
         AND column_name = 'organization_id' AND is_nullable = 'YES'
    ) THEN
      already := already + 1;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t)
      INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
      tightened := tightened + 1;
    ELSE
      -- Loud, but not fatal. These rows are invisible to every tenant already;
      -- failing the deploy would not make them visible, it would only stop the
      -- release. Fix the orphans, then re-run this migration.
      skipped := skipped + 1;
      RAISE WARNING
        'organization_id NOT NULL SKIPPED for %: % row(s) have a NULL organization_id. '
        'Those rows are already invisible to every tenant. Investigate which write '
        'path produced them, backfill or delete, then re-run this migration.',
        t, null_count;
    END IF;
  END LOOP;

  RAISE NOTICE
    'organization_id NOT NULL: % tightened, % already enforced, % skipped (see warnings above).',
    tightened, already, skipped;
END $$;
