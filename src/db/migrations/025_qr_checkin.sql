-- 025_qr_checkin.sql
-- QR check-in infrastructure + expanded attendance for all user types.

-- ── QR tokens table ─────────────────────────────────────────────────────────
-- Stores per-user STATIC QR secrets. Dynamic QR is time-windowed using this
-- secret without DB writes. Single-use QR burns the token on use.
CREATE TABLE IF NOT EXISTS qr_tokens (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT        NOT NULL,
  user_type   TEXT        NOT NULL DEFAULT 'client'
              CHECK (user_type IN ('client', 'trainer', 'staff', 'user')),
  secret      TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Defensive: if qr_tokens existed before this migration with an incomplete schema,
-- add any missing columns so the indexes below succeed.
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS user_id     TEXT;
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS user_type   TEXT NOT NULL DEFAULT 'client';
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS secret      TEXT;
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Drop+recreate the partial index in case a prior failed run left it half-built.
DROP INDEX IF EXISTS qr_tokens_user_idx;
CREATE UNIQUE INDEX qr_tokens_user_idx ON qr_tokens(user_id, user_type) WHERE is_active = TRUE;

-- ── Expand attendance_logs ref_type ─────────────────────────────────────────
-- Add 'staff' and 'user' as valid ref_types for non-client users.
ALTER TABLE attendance_logs
  DROP CONSTRAINT IF EXISTS attendance_logs_ref_type_check;

ALTER TABLE attendance_logs
  ADD CONSTRAINT attendance_logs_ref_type_check
  CHECK (ref_type IN ('client', 'trainer', 'staff', 'user'));

-- ── Add checkout support columns ─────────────────────────────────────────────
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

-- Update duration_minutes when checkout is logged
CREATE OR REPLACE FUNCTION update_attendance_duration()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.check_out_time IS NOT NULL AND OLD.check_out_time IS NULL
     AND NEW.check_in_time IS NOT NULL THEN
    NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.check_out_time - NEW.check_in_time)) / 60;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_duration ON attendance_logs;
CREATE TRIGGER trg_attendance_duration
  BEFORE UPDATE ON attendance_logs
  FOR EACH ROW EXECUTE FUNCTION update_attendance_duration();

-- ── Attendance index for dashboard queries ───────────────────────────────────
CREATE INDEX IF NOT EXISTS att_date_reftype_idx ON attendance_logs(date DESC, ref_type);
CREATE INDEX IF NOT EXISTS att_checkin_idx ON attendance_logs(check_in_time DESC) WHERE check_in_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS att_userid_date_idx ON attendance_logs(user_id, date DESC) WHERE user_id IS NOT NULL;
