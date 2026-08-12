-- 117_ai_conversation_pinning.sql
-- Lets a user pin AI Coach conversations to the top of their history list,
-- and gives the rename flow a column to write to (title already existed but
-- was only ever auto-set from the first message).
--
-- Idempotent: safe to re-run.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- The history list is always "this user's conversations, pinned first, then
-- most recently updated" — this index serves that ordering directly.
CREATE INDEX IF NOT EXISTS ai_conversations_user_pinned_idx
  ON ai_conversations (user_id, pinned DESC, updated_at DESC);
