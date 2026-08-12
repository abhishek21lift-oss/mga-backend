-- ============================================================
-- 041_trainers_missing_columns.sql
-- Adds columns to trainers table that the API route references
-- but that were absent from the original schema.sql definition.
-- Without these columns POST /api/trainers fails with
-- "column does not exist" errors.
-- ============================================================

ALTER TABLE trainers ADD COLUMN IF NOT EXISTS dob             DATE;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS gender          TEXT
  CHECK (gender IN ('Male','Female','Other') OR gender IS NULL);
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS address         TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS role            TEXT NOT NULL DEFAULT 'Personal Trainer';
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS salary          NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS notes           TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS biometric_code  TEXT;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS biometric_added BOOLEAN NOT NULL DEFAULT FALSE;

-- Also convert certifications from TEXT[] to TEXT so the API can store
-- a comma-separated string directly (the route never uses array literals).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trainers'
      AND column_name = 'certifications'
      AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE trainers
      ALTER COLUMN certifications TYPE TEXT
      USING array_to_string(certifications, ', ');
  END IF;
END $$;
