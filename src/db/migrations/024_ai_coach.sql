-- 024_ai_coach.sql
-- 619 Fitness AI Coach — conversation storage and usage tracking.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,                         -- auto-generated from first user message
  client_id   TEXT,                         -- when trainer is coaching a specific client
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_idx ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  conversation_id  TEXT        NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT        NOT NULL,
  tokens_prompt    INTEGER     DEFAULT 0,
  tokens_completion INTEGER    DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_messages_conv_idx ON ai_messages(conversation_id, created_at ASC);

-- Per-request usage log for monitoring and cost control
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id          TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT,
  model            TEXT,
  tokens_prompt    INTEGER     DEFAULT 0,
  tokens_completion INTEGER    DEFAULT 0,
  tokens_total     INTEGER     DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage_log(user_id, created_at DESC);
