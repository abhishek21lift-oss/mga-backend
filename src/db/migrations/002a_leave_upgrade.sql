-- ─── 002: Upgrade leave_requests with new columns ────────────────
-- This migration adds columns to leave_requests that were missing
-- from the initial schema. Safe to run on existing databases.

DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type TEXT NOT NULL DEFAULT 'other';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS admin_note TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_leave_type_check'
  ) THEN
    ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_check
      CHECK (leave_type IN ('sick','casual','earned','emergency','unpaid','other'));
  END IF;
END $$;

-- Update trigger list to include leave_requests
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['leave_requests'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at
           BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END $$;

SELECT 'Migration 002 complete' AS status;
