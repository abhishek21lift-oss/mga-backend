-- Migration 022: Security hardening
-- Adds session_id binding to webauthn_challenges (C-04)
-- Adds admin_reset_intents table for two-step admin reset (H-04)

-- C-04: bind WebAuthn auth challenges to a session cookie
--
-- Guarded because webauthn_challenges is created by migration 026, i.e. after
-- this one — on a fresh database there is no table to alter and the migration
-- aborted here. 026 declares session_id in the table itself, so a fresh
-- install ends up with the same shape by a different route; this block is
-- what upgrades a database that already had the pre-026 table.
DO $$ BEGIN
  IF to_regclass('public.webauthn_challenges') IS NOT NULL THEN
    ALTER TABLE webauthn_challenges
      ADD COLUMN IF NOT EXISTS session_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_session_id
      ON webauthn_challenges (session_id)
      WHERE session_id IS NOT NULL;
  END IF;
END $$;

-- H-04: two-step admin data-reset with email OTP
CREATE TABLE IF NOT EXISTS admin_reset_intents (
  id          SERIAL PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL DEFAULT 'reset-all',
  otp_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admin_id, action)
);

CREATE INDEX IF NOT EXISTS idx_admin_reset_intents_admin
  ON admin_reset_intents (admin_id, action);
