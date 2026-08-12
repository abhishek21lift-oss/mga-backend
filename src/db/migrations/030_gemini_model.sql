-- 030_gemini_model.sql
-- Store the selected Gemini model in ai_provider_settings so admins can
-- choose which model to use without redeploying.

ALTER TABLE ai_provider_settings
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-2.0-flash';
