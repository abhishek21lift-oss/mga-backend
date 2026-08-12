-- ============================================================
-- 123_feature_manager.sql
--
-- Feature Manager for the Control Centre: a registry of what the
-- product can do, which plans include it, and per-studio overrides.
--
-- ── The safety property this migration is built around ──────────────
--
-- Every feature is seeded ENABLED, NOT plan-gated, and globally on.
-- Resolution therefore returns "enabled" for every studio the moment
-- this runs, which is exactly what is true today. Nothing in the Admin
-- Studio changes until an operator deliberately flips something, and
-- flipping it is an audited act. A feature registry that silently
-- switched something off on deploy would be a catastrophe dressed as
-- a migration.
--
-- ── Resolution order, most specific wins ─────────────────────────────
--
--   1. global_enabled = FALSE   → off everywhere. The incident lever:
--                                 one flip kills a misbehaving feature
--                                 across the platform without a deploy.
--   2. organization_features    → this studio's explicit override
--                                 (optionally expiring, for a trial of
--                                 a paid feature).
--   3. plan_features            → consulted ONLY when is_plan_gated.
--   4. default_enabled          → the catalogue's own default.
--
-- is_core features skip all of it and are always on. Disabling Clients
-- would leave a studio staring at an empty product, so the switch does
-- not exist rather than being merely discouraged.
--
-- The catalogue below is transcribed from the app's actual navigation
-- (frontend src/lib/nav-config.ts), not invented. A registry listing
-- capabilities that do not exist is worse than no registry, because
-- every entry in it is a promise that toggling it does something.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_features (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL DEFAULT 'general',
  -- Fallback when no override and no plan grant applies.
  default_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- When TRUE the studio's plan is consulted; when FALSE the plan is
  -- irrelevant and the feature is available to everyone by default.
  is_plan_gated   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Cannot be switched off anywhere. Guarded in SQL and in the API.
  is_core         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Platform kill switch. FALSE beats every override below it.
  global_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A core feature that is off is a contradiction; the database refuses it
-- so no code path can produce one.
DO $$ BEGIN
  ALTER TABLE platform_features
    ADD CONSTRAINT platform_features_core_stays_on
    CHECK (NOT is_core OR (global_enabled AND default_enabled AND NOT is_plan_gated));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Which plans include which features ───────────────────────────────
CREATE TABLE IF NOT EXISTS plan_features (
  plan_code    TEXT NOT NULL REFERENCES subscription_plans(code) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL REFERENCES platform_features(key)   ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_code, feature_key)
);

-- ── Per-studio overrides ─────────────────────────────────────────────
-- reason is required by the API, not by the schema: a NOT NULL here would
-- break the ON CONFLICT upsert path for rows written before it existed.
CREATE TABLE IF NOT EXISTS organization_features (
  organization_id UUID NOT NULL REFERENCES organizations(id)   ON DELETE CASCADE,
  feature_key     TEXT NOT NULL REFERENCES platform_features(key) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL,
  reason          TEXT,
  -- For "let them try Insights for 30 days". A lapsed override is ignored
  -- by resolution rather than deleted, so the history of the grant survives.
  expires_at      TIMESTAMPTZ,
  set_by          UUID,
  set_by_name     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_org_features_feature ON organization_features(feature_key);
CREATE INDEX IF NOT EXISTS idx_org_features_expiry  ON organization_features(expires_at)
  WHERE expires_at IS NOT NULL;

-- ── Catalogue ────────────────────────────────────────────────────────
-- ON CONFLICT updates only the descriptive columns. The operator-controlled
-- switches (default_enabled, is_plan_gated, global_enabled) are deliberately
-- NOT overwritten: re-running migrations must never undo an operator's
-- deliberate change, and a kill switch that a redeploy silently re-armed
-- would be worse than useless during an incident.
INSERT INTO platform_features (key, name, description, category, is_core, sort_order) VALUES
  ('clients',            'Clients',              'Client records, leads and onboarding.',                       'core',          TRUE,  10),
  ('sessions',           'Sessions',             'Scheduling, session balance and history.',                    'core',          TRUE,  20),
  ('attendance',         'Attendance',           'QR check-in and attendance records.',                         'operations',    FALSE, 30),
  ('programs',           'Programs',             'Workout plans, workout log and diet plans.',                  'training',      FALSE, 40),
  ('exercise_library',   'Exercise Library',     'The studio''s exercise catalogue.',                           'training',      FALSE, 50),
  ('screening',          'Screening & Assessments', 'PAR-Q, consent, fitness testing and the assessment suite.', 'training',     FALSE, 60),
  ('progress_photos',    'Progress Photos',      'Photo capture and transformation tracking.',                  'training',      FALSE, 70),
  ('finance',            'Finance',              'Payments, invoices, dues and the balance sheet.',             'business',      FALSE, 80),
  ('packages',           'Session Packages',     'Package catalogue and pricing.',                              'business',      FALSE, 90),
  ('insights',           'Insights & Reports',   'Revenue, renewal, utilisation and attendance reporting.',     'business',      FALSE, 100),
  ('communication',      'Communication',        'WhatsApp/SMS, campaigns, offers, feedback and automation.',   'engagement',    FALSE, 110),
  ('member_portal',      'Member Portal',        'The member-facing dashboard, classes and payments.',          'engagement',    FALSE, 120),
  ('ai_suite',           'AI Suite',             'AI Coach and the workout, diet and progress generators.',     'ai',            FALSE, 130),
  ('ai_knowledge_base',  'AI Knowledge Base',    'Uploading the studio''s own documents for the AI to use.',    'ai',            FALSE, 140),
  ('branches',           'Branches',             'Multiple locations under one studio.',                        'administration', FALSE, 150),
  ('integrations',       'Integrations',         'Third-party connections configured by the studio.',           'administration', FALSE, 160),
  ('passkeys',           'Passkeys',             'WebAuthn sign-in for studio staff.',                          'administration', FALSE, 170)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      is_core = EXCLUDED.is_core,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();

-- Every plan gets every feature. Combined with is_plan_gated = FALSE this is
-- belt and braces: even if an operator later flips a feature to plan-gated,
-- no existing studio loses it by surprise — the matrix already grants it, and
-- taking it away is then a second, deliberate act.
INSERT INTO plan_features (plan_code, feature_key, enabled)
SELECT p.code, f.key, TRUE FROM subscription_plans p CROSS JOIN platform_features f
ON CONFLICT (plan_code, feature_key) DO NOTHING;

-- ── Row Level Security (added retroactively — audit finding C-01) ────
--
-- This migration created the table(s) below without RLS, leaving them
-- reachable through PostgREST with the publishable key. Migration 131
-- swept the live database, but 131 sorts BEFORE this file: a database
-- rebuilt from scratch would run the sweep first and then recreate the
-- gap here. Declaring it in the migration that owns the table makes it
-- order-independent and self-contained.
--
-- Idempotent; already-applied databases are unaffected.

ALTER TABLE platform_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_features FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_features'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_features
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE plan_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON plan_features FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'plan_features'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON plan_features
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE organization_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organization_features FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_features'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON organization_features
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
