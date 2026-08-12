-- ============================================================
-- 126_ai_control_centre.sql
--
-- The half of the AI Control Centre that needs new state: cost
-- rates and per-studio token allowances.
--
-- The reporting half needs nothing — ai_usage_log (migration 024,
-- extended by 029/042/043) already records model, provider, intent,
-- prompt/completion/total tokens, latency and whether a fallback was
-- used, on every AI request. That is enough to answer who is using the
-- AI Suite and how hard, today, from real rows.
--
-- ── Cost is operator-entered, never inferred ─────────────────────────
--
-- There is no default price table here and no built-in per-model rate.
-- Model pricing changes without notice and differs per account; a rate
-- I hardcoded today would silently become a lie, and an invented cost
-- shown next to real token counts reads as equally factual. So a model
-- with no configured rate reports tokens and NO cost, and the API says
-- which models are unpriced so the UI can say so too.
--
-- ── Enforcement ships OFF ────────────────────────────────────────────
--
-- enforcement_enabled defaults FALSE, so installing this migration
-- cannot cut a studio off from a feature it is paying for. The limits
-- are recorded and reportable immediately; they only start refusing
-- requests when an operator deliberately switches enforcement on. Same
-- reasoning as the Feature Manager seeding permissive in 123.
--
-- Idempotent.
-- ============================================================

-- ── Platform-wide AI settings (singleton) ────────────────────────────
CREATE TABLE IF NOT EXISTS ai_platform_settings (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Master switch. FALSE means limits are advisory: recorded, reported,
  -- and never enforced against a request.
  enforcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Applied to studios with no explicit limit row. NULL = unlimited,
  -- which is what every studio has today.
  default_monthly_tokens BIGINT,
  -- What an operator wants to be warned at, as a percentage of the cap.
  warn_at_pct         INTEGER NOT NULL DEFAULT 80
                      CHECK (warn_at_pct > 0 AND warn_at_pct <= 100),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

INSERT INTO ai_platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ── Per-model cost rates ─────────────────────────────────────────────
-- Seeded EMPTY on purpose (see the header). Prompt and completion are
-- priced separately because they always are.
CREATE TABLE IF NOT EXISTS ai_model_rates (
  model                TEXT PRIMARY KEY,
  provider             TEXT,
  -- NUMERIC, not float: these are money multiplied by large token counts,
  -- and float drift would show up in the totals.
  prompt_per_1k_inr    NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (prompt_per_1k_inr >= 0),
  completion_per_1k_inr NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (completion_per_1k_inr >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT
);

-- ── Per-studio allowance ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_ai_limits (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL = unlimited for this studio, overriding any platform default.
  -- Distinct from "no row", which means "fall back to the default".
  monthly_tokens  BIGINT CHECK (monthly_tokens IS NULL OR monthly_tokens >= 0),
  reason          TEXT,
  set_by          UUID,
  set_by_name     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes for the reporting queries ────────────────────────────────
-- ai_usage_log carries no organization_id, so every per-studio figure
-- joins through users. Both sides of that join need to be cheap.
CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_provider_idx ON ai_usage_log (provider, created_at DESC);

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

ALTER TABLE ai_platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_platform_settings FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_platform_settings'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON ai_platform_settings
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE ai_model_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_model_rates FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_model_rates'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON ai_model_rates
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE organization_ai_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organization_ai_limits FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_ai_limits'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON organization_ai_limits
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
