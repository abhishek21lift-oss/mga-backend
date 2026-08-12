-- ============================================================
-- 129_ai_model_routing.sql
--
-- Operator control over which AI models the platform routes to.
--
-- Today the three model tiers come from environment variables
-- (AI_PRIMARY_MODEL / AI_SECONDARY_MODEL / AI_FALLBACK_MODEL). That
-- was the right call — it kept model names out of the source — but it
-- means changing a model is a Render dashboard edit plus a redeploy,
-- with the service down in between. When a provider deprecates a model
-- or starts erroring, that is the wrong shape of operation: the fix is
-- a one-line change and it should not require shipping.
--
-- This table holds an OPTIONAL override per tier. NULL means "use the
-- environment variable", which is the state every deploy starts in, so
-- applying this migration changes no routing whatsoever. An operator
-- has to deliberately set a value for anything to differ.
--
-- Deliberately a singleton (id = 'singleton', same shape as the
-- existing ai_provider_settings row). Model routing is a platform-wide
-- decision; per-studio model selection would let one studio's config
-- silently change another studio's bill, and there is no product reason
-- for it.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_ai_settings (
  id                TEXT PRIMARY KEY DEFAULT 'singleton'
                    CHECK (id = 'singleton'),

  -- NULL = fall back to the corresponding environment variable.
  primary_model     TEXT,
  secondary_model   TEXT,
  fallback_model    TEXT,

  updated_by        TEXT,
  updated_by_name   TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_ai_settings (id) VALUES ('singleton')
  ON CONFLICT (id) DO NOTHING;

-- Same convention as every other platform table: no direct client
-- access. Reads and writes go through the API, which checks the caller
-- is a platform operator.
ALTER TABLE platform_ai_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'platform_ai_settings' AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_ai_settings
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;

REVOKE ALL ON platform_ai_settings FROM anon, authenticated;
