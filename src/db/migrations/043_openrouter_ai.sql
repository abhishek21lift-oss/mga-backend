-- 043_openrouter_ai.sql
-- Migrate AI layer from Token Router / MiniMax-M3 to OpenRouter multi-model.
-- Adds intent_type, latency_ms, used_fallback to usage log for routing analytics.

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS intent_type   TEXT    DEFAULT 'fitness',
  ADD COLUMN IF NOT EXISTS latency_ms    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS used_fallback BOOLEAN DEFAULT FALSE;

-- Reset default provider to openrouter on new rows
ALTER TABLE ai_messages    ALTER COLUMN provider SET DEFAULT 'openrouter';
ALTER TABLE ai_usage_log   ALTER COLUMN provider SET DEFAULT 'openrouter';

-- Reset singleton settings row to openrouter mode
UPDATE ai_provider_settings
  SET mode = 'openrouter', updated_at = NOW()
  WHERE id = 'singleton';

INSERT INTO ai_provider_settings (id, mode, updated_at)
VALUES ('singleton', 'openrouter', NOW())
ON CONFLICT (id) DO UPDATE
  SET mode = 'openrouter', updated_at = NOW();

-- Index for intent-type analytics
CREATE INDEX IF NOT EXISTS ai_usage_intent_idx ON ai_usage_log(intent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_model_idx  ON ai_usage_log(model, created_at DESC);
