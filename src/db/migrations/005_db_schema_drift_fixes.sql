-- 005_db_schema_drift_fixes.sql
-- Fix remaining schema drift identified by deep audit:
--   1. Missing UNIQUE on clients(email) and trainers(email)
--   2. face_checkin_logs CHECK constraint missing 'frozen','error' statuses
--   3. face_checkin_logs default status mismatch (success vs unknown)
--   4. Missing face_checkin_logs indexes from 004 migration

-- ─── 1. UNIQUE constraints on email columns ────────────────────────────
-- Only enforce where email is actually provided (not null, not empty)
DO $$ BEGIN
  IF to_regclass('clients_email_uniq') IS NULL THEN
    CREATE UNIQUE INDEX clients_email_uniq ON clients (LOWER(email))
      WHERE email IS NOT NULL AND email != '';
  END IF;
  IF to_regclass('trainers_email_uniq') IS NULL THEN
    CREATE UNIQUE INDEX trainers_email_uniq ON trainers (LOWER(email))
      WHERE email IS NOT NULL AND email != '';
  END IF;
END $$;

-- ─── 2. Fix face_checkin_logs CHECK constraint ─────────────────────────
-- The original migration (002) allows: success,failed,expired,denied,unknown
-- The newer migration (004) expects:   success,unknown,expired,denied,frozen,error
-- We need to drop and recreate the constraint to accept both sets.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'face_checkin_logs'::regclass
      AND conname LIKE '%status%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'face_checkin_logs'::regclass
          AND conname LIKE '%status%'
          AND pg_get_constraintdef(oid) LIKE '%frozen%'
      )
  ) THEN
    ALTER TABLE face_checkin_logs DROP CONSTRAINT face_checkin_logs_status_check;
    ALTER TABLE face_checkin_logs ADD CONSTRAINT face_checkin_logs_status_check
      CHECK (status IN ('success','failed','unknown','expired','denied','frozen','error'));
  END IF;
END $$;

-- Change default to 'unknown' to match 004_face_checkin_logs.sql spec
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'face_checkin_logs'
      AND column_name = 'status'
      AND column_default IS NOT DISTINCT FROM '''success''::text'
  ) THEN
    ALTER TABLE face_checkin_logs ALTER COLUMN status SET DEFAULT 'unknown';
  END IF;
END $$;

-- ─── 3. Indexes from 004_face_checkin_logs.sql ─────────────────────────
CREATE INDEX IF NOT EXISTS face_log_client_idx ON face_checkin_logs (client_id);
CREATE INDEX IF NOT EXISTS face_log_date_idx   ON face_checkin_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS face_log_status_idx ON face_checkin_logs (status);

SELECT 'Migration 005 complete — schema drift fixes applied' AS status;
