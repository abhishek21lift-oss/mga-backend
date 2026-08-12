-- Migration 045: user_webauthn_credentials — staff/admin/trainer passkey login
-- Separate from the member-focused webauthn_credentials table (which uses member_id FK to clients).
-- This table uses user_id FK to the users table for staff authentication.

-- Allow challenges to be tied to a staff user (not just a member)
ALTER TABLE webauthn_challenges ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_id ON webauthn_challenges (user_id);

-- Staff passkey credentials
CREATE TABLE IF NOT EXISTS user_webauthn_credentials (
  id            TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[],
  device_name   TEXT NOT NULL DEFAULT 'Passkey',
  device_type   TEXT NOT NULL DEFAULT 'unknown',
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_webauthn_creds_user_id       ON user_webauthn_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_user_webauthn_creds_credential_id ON user_webauthn_credentials (credential_id);
CREATE INDEX IF NOT EXISTS idx_user_webauthn_creds_active        ON user_webauthn_credentials (user_id, is_active) WHERE deleted_at IS NULL;
