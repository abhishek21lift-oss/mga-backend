-- 029_ai_providers.sql
-- Multi-provider AI support: track which provider served each message/request,
-- and store the active routing mode (OpenAI, Gemini, auto, fallback, etc.)

-- Add provider column to usage log (existing rows default to 'openai')
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai';

-- Add provider column to messages (existing rows default to 'openai')
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openai';

-- Singleton row that holds the active routing mode
CREATE TABLE IF NOT EXISTS ai_provider_settings (
  id         TEXT PRIMARY KEY DEFAULT 'singleton',
  mode       TEXT NOT NULL DEFAULT 'auto',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_provider_settings (id, mode) VALUES ('singleton', 'auto')
  ON CONFLICT DO NOTHING;
