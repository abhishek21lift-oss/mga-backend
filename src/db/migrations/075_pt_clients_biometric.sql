-- 075_pt_clients_biometric.sql
-- Extends pt_clients with the same biometric/face-recognition columns
-- `clients` already has, so real PT client data (the only client data
-- this deployment actually has) can use face check-in, face enrollment,
-- and NFC/RFID/manual biometric-code check-in — previously these
-- features only worked against the legacy `clients` table, which has
-- zero rows in production.

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS biometric_code TEXT,
  ADD COLUMN IF NOT EXISTS face_descriptor JSONB,
  ADD COLUMN IF NOT EXISTS face_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_deletion_requested_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_clients_biometric_code
  ON pt_clients (biometric_code) WHERE biometric_code IS NOT NULL;

-- face_descriptors.client_id was FK'd to clients(id) only — same problem
-- migration 032 already fixed for webauthn_credentials.member_id.
ALTER TABLE face_descriptors DROP CONSTRAINT IF EXISTS face_descriptors_client_id_fkey;

COMMENT ON COLUMN face_descriptors.client_id
  IS 'Can reference clients.id OR pt_clients.id — FK deliberately removed to support both tables (mirrors webauthn_credentials.member_id, see migration 032).';
