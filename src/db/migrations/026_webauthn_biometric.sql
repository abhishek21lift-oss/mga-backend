-- Migration 026: WebAuthn credentials + biometric attendance tables

-- ── WebAuthn credentials ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  device_name   TEXT NOT NULL DEFAULT 'Unknown Device',
  device_type   TEXT NOT NULL DEFAULT 'unknown',
  transports    TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_member
  ON webauthn_credentials (member_id);

-- ── WebAuthn challenges (may already exist from earlier migrations) ─
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL UNIQUE,
  member_id  TEXT,
  session_id TEXT,
  type       TEXT NOT NULL DEFAULT 'registration',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
);

ALTER TABLE webauthn_challenges ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE webauthn_challenges ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes';

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_session_id
  ON webauthn_challenges (session_id);

-- ── Biometric attendance ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_attendance (
  id                       TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  member_id                TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_name              TEXT,
  verification_method      TEXT NOT NULL DEFAULT 'biometric',
  device_name              TEXT,
  latitude                 NUMERIC(10,6),
  longitude                NUMERIC(10,6),
  check_in_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_out_at             TIMESTAMPTZ,
  session_duration_minutes INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist in case table was created by a previous partial migration
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS member_name              TEXT;
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS verification_method      TEXT NOT NULL DEFAULT 'biometric';
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS device_name              TEXT;
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS latitude                 NUMERIC(10,6);
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS longitude                NUMERIC(10,6);
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS check_in_at              TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS check_out_at             TIMESTAMPTZ;
ALTER TABLE biometric_attendance ADD COLUMN IF NOT EXISTS session_duration_minutes INTEGER;

CREATE INDEX IF NOT EXISTS idx_biometric_attendance_member
  ON biometric_attendance (member_id);
CREATE INDEX IF NOT EXISTS idx_biometric_attendance_checkin
  ON biometric_attendance (check_in_at DESC);
