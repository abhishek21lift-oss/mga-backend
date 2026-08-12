-- ============================================================
-- 034_face_checkin_logs_attendance_id.sql
--
-- Adds the attendance_id column to face_checkin_logs.
-- This column is referenced by logCheckIn() in checkin.js
-- and indexed by migration 014, but was never added to the
-- table definition in 004a_face_checkin_logs.sql.
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'face_checkin_logs'
      AND column_name = 'attendance_id'
  ) THEN
    ALTER TABLE face_checkin_logs
      ADD COLUMN attendance_id TEXT REFERENCES attendance_logs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The index in 014 may have failed if the column didn't exist yet — recreate safely
CREATE INDEX IF NOT EXISTS face_log_attendance_idx ON face_checkin_logs (attendance_id)
  WHERE attendance_id IS NOT NULL;

SELECT 'Migration 034 complete — attendance_id column added to face_checkin_logs' AS status;
