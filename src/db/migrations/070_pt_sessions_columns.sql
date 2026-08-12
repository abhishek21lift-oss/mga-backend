-- ============================================================
-- 070_pt_sessions_columns.sql
-- The Schedule Session UI (src/app/pt-os/schedule-session/page.tsx)
-- collects duration, session type, and a "recurring weekly" toggle,
-- but pt_sessions had nowhere to store any of them — POST /sessions
-- silently dropped all three. Add the columns; recurrence_id is a
-- plain shared tag (no FK) so a batch of weekly-recurring sessions
-- created from one booking can be identified as a group later.
-- ============================================================

ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS duration_minutes INT NOT NULL DEFAULT 60;
ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT '1-on-1';
ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS recurrence_id TEXT;

-- member_id/starts_at/ends_at are NOT NULL with no default, and trainer_id
-- is NOT NULL despite its own FK being ON DELETE SET NULL (self-contradictory).
-- All four are remnants of an unrelated, never-wired "member portal" booking
-- schema (see /api/v1/pt-sessions, which targets columns that don't even
-- exist here) — every PT-OS session booking has been failing on these
-- constraints (confirmed: 0 rows in pt_sessions despite the feature being
-- in active use), silently masked by an empty catch block on the frontend.
-- Guarded per column: these are exactly the "remnants of an unrelated, never-
-- wired member portal schema" described above, so a database built from this
-- repo never has them and the bare ALTERs aborted the migration. Where the
-- column does not exist there is no NOT NULL to drop, which is the state this
-- block is trying to reach anyway.
DO $$
DECLARE col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['member_id', 'starts_at', 'ends_at', 'trainer_id'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pt_sessions' AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE pt_sessions ALTER COLUMN %I DROP NOT NULL', col);
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE pt_sessions ADD CONSTRAINT pt_sessions_session_type_check
    CHECK (session_type IN ('1-on-1', 'group', 'assessment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS pt_sessions_recurrence_idx ON pt_sessions (recurrence_id) WHERE recurrence_id IS NOT NULL;
