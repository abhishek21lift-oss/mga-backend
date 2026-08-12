-- 011_face_enrollment_fixes.sql
-- Updates to face enrollment system:
--   1. Add updated_at to face_descriptors
--   2. Extend face_checkin_logs CHECK to include 'enrolled' and 'revoked'
--   3. Update 005 migration constraint to match

-- ─── 1. Add updated_at to face_descriptors ──────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'face_descriptors'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE face_descriptors ADD COLUMN updated_at TIMESTAMPTZ;
  END IF;
END $$;

-- ─── 2. Extend face_checkin_logs CHECK constraint ────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'face_checkin_logs'::regclass
      AND conname LIKE '%status%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'face_checkin_logs'::regclass
          AND conname LIKE '%status%'
          AND pg_get_constraintdef(oid) LIKE '%enrolled%'
      )
  ) THEN
    ALTER TABLE face_checkin_logs DROP CONSTRAINT face_checkin_logs_status_check;
    ALTER TABLE face_checkin_logs ADD CONSTRAINT face_checkin_logs_status_check
      CHECK (status IN ('success','failed','unknown','expired','denied','frozen','error','enrolled','revoked'));
  END IF;
END $$;

SELECT 'Migration 011 complete — face enrollment fixes applied' AS status;
