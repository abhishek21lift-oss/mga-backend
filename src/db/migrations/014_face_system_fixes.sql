-- 014_face_system_fixes.sql
-- Fix schema drift and bugs in the face enrollment system:
--   1. Make face_descriptors.angle nullable with a default
--   2. Add missing status values to face_checkin_logs CHECK constraint
--   3. Add missing default for face_checkin_logs.status
--   4. Index on attendance_id (guarded — column added in migration 034)
--   5. Fix orphaned enrollment data

-- ─── 1. Make angle nullable with default 'front' ─────────────────
-- 013b adds the column; this step only tweaks nullability if it was
-- somehow created NOT NULL by another path.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'face_descriptors'
      AND column_name = 'angle'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE face_descriptors ALTER COLUMN angle DROP NOT NULL;
    ALTER TABLE face_descriptors ALTER COLUMN angle SET DEFAULT 'front';
  END IF;
END $$;

-- ─── 2. Ensure face_checkin_logs CHECK constraint has all statuses ──
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'face_checkin_logs'::regclass
      AND conname LIKE '%status%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'face_checkin_logs'::regclass
          AND conname LIKE '%status%'
          AND pg_get_constraintdef(oid) LIKE '%revoked%'
      )
  ) THEN
    ALTER TABLE face_checkin_logs DROP CONSTRAINT face_checkin_logs_status_check;
    ALTER TABLE face_checkin_logs ADD CONSTRAINT face_checkin_logs_status_check
      CHECK (status = ANY (ARRAY['success'::text, 'failed'::text, 'unknown'::text,
                                 'expired'::text, 'denied'::text, 'frozen'::text,
                                 'error'::text, 'enrolled'::text, 'revoked'::text]));
  END IF;
END $$;

-- ─── 3. Set default status on face_checkin_logs ────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'face_checkin_logs'
      AND column_name = 'status'
      AND column_default IS NULL
  ) THEN
    ALTER TABLE face_checkin_logs ALTER COLUMN status SET DEFAULT 'unknown';
  END IF;
END $$;

-- ─── 4. Index on attendance_id for faster joins ────────────────────
-- attendance_id is added by migration 034. Skip index creation here if
-- the column does not yet exist — migration 034 will create it.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'face_checkin_logs'
      AND column_name = 'attendance_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS face_log_attendance_idx
      ON face_checkin_logs (attendance_id)
      WHERE attendance_id IS NOT NULL;
  END IF;
END $$;

-- ─── 5. Fix orphaned clients: sync face_enrolled flag ──────────────
UPDATE clients c
   SET face_enrolled = TRUE
 WHERE c.face_descriptor IS NOT NULL
   AND c.face_enrolled = FALSE
   AND EXISTS (
     SELECT 1 FROM face_checkin_logs l
      WHERE l.client_id = c.id AND l.status = 'success'
   );

-- Restore a face_descriptors row for any orphaned client.
-- 013b has already converted both columns to JSONB, so this INSERT
-- works correctly on all fresh and upgraded databases.
INSERT INTO face_descriptors (id, client_id, angle, descriptor, is_active, enrolled_at)
SELECT gen_random_uuid()::TEXT,
       c.id,
       'front',
       c.face_descriptor,
       TRUE,
       COALESCE(c.face_enrolled_at, NOW())
FROM clients c
WHERE c.face_descriptor IS NOT NULL
  AND c.face_enrolled = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM face_descriptors d
     WHERE d.client_id = c.id AND d.is_active = TRUE
  )
ON CONFLICT DO NOTHING;

SELECT 'Migration 014 complete — face system fixes applied' AS status;
