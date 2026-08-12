-- 047_refresh_tokens.sql
-- Persistent refresh token store for the 15min access token + 7d refresh token pattern.
-- token_hash stores SHA-256(raw_token) — never the raw bytes.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT, matching users.id. It was declared UUID, which cannot reference a
  -- TEXT primary key — Postgres rejects the foreign key outright, so a fresh
  -- database stopped here. TEXT ids are the convention throughout this schema;
  -- migration 033 explicitly converts a stray UUID key back to TEXT "to match
  -- the rest of the schema". The live database already has this table, so
  -- CREATE TABLE IF NOT EXISTS leaves it untouched there.
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash    ON refresh_tokens(token_hash);
CREATE        INDEX IF NOT EXISTS idx_refresh_tokens_user    ON refresh_tokens(user_id);
CREATE        INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at)
  WHERE revoked_at IS NULL;

-- Purge expired/revoked tokens older than 7 days on install
-- (production purge should be a scheduled job)
DELETE FROM refresh_tokens
 WHERE expires_at < NOW() - INTERVAL '7 days'
    OR revoked_at  < NOW() - INTERVAL '7 days';
