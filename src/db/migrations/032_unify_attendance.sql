-- 032_unify_attendance.sql
-- 1. Drop FK on webauthn_credentials so PT clients can enroll passkeys.
-- 2. Backfill historical biometric_attendance rows into attendance_logs.

-- ── 1. Drop FK constraint ────────────────────────────────────────────────────
ALTER TABLE webauthn_credentials
  DROP CONSTRAINT IF EXISTS webauthn_credentials_member_id_fkey;

-- Add a comment so it's clear this is intentional
COMMENT ON COLUMN webauthn_credentials.member_id
  IS 'Can reference clients.id OR pt_clients.id — FK deliberately removed to support both tables.';

-- ── 2. Backfill biometric_attendance → attendance_logs ───────────────────────
-- Map verification_method to the canonical method values used in attendance_logs.
-- ON CONFLICT DO NOTHING: if a manual record already exists for that person+date, skip.
INSERT INTO attendance_logs
  (id, ref_id, ref_type, ref_name, date,
   check_in_time, check_out_time, status, method,
   duration_minutes, device_info)
SELECT
  gen_random_uuid()::TEXT,
  ba.member_id,
  'client',
  COALESCE(ba.member_name, c.name, 'Unknown'),
  ba.check_in_at::date,
  ba.check_in_at,
  ba.check_out_at,
  CASE
    WHEN ba.check_in_at::time > '10:00:00' THEN 'late'
    ELSE 'present'
  END,
  LOWER(REPLACE(COALESCE(ba.verification_method, 'passkey'), ' ', '_')),
  ba.session_duration_minutes,
  ba.device_name
FROM biometric_attendance ba
LEFT JOIN clients c ON c.id = ba.member_id
ON CONFLICT (ref_id, ref_type, date) DO NOTHING;
