-- ============================================================
-- 013b_face_descriptor_columns.sql
--
-- Prerequisites for migration 014 and checkin.js:
--
--   1. Add 'angle' column to face_descriptors
--      Migration 014 and checkin.js both reference this column in
--      INSERT statements, but migration 001 never created it.
--
--   2. Convert face_descriptors.descriptor from FLOAT8[] to JSONB
--      checkin.js uses formatDescriptorToJson() + ::jsonb cast on every
--      INSERT. FLOAT8[] rejects a ::jsonb cast → all enrollments fail.
--
--   3. Convert clients.face_descriptor from FLOAT8[] to JSONB
--      Same issue: checkin.js does $1::jsonb on the clients UPDATE.
--
-- All statements are idempotent (safe to re-run).
-- ============================================================

-- ── 1. Add 'angle' column if missing ─────────────────────────────────
ALTER TABLE face_descriptors ADD COLUMN IF NOT EXISTS angle TEXT DEFAULT 'front';

-- ── 2. Convert face_descriptors.descriptor: FLOAT8[] → JSONB ─────────
-- udt_name '_float8' identifies a FLOAT8 / double-precision array column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'face_descriptors'
      AND column_name = 'descriptor'
      AND udt_name    = '_float8'
  ) THEN
    ALTER TABLE face_descriptors
      ALTER COLUMN descriptor TYPE JSONB USING to_jsonb(descriptor);
  END IF;
END $$;

-- ── 3. Convert clients.face_descriptor: FLOAT8[] → JSONB ─────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'clients'
      AND column_name = 'face_descriptor'
      AND udt_name    = '_float8'
  ) THEN
    ALTER TABLE clients
      ALTER COLUMN face_descriptor TYPE JSONB USING to_jsonb(face_descriptor);
  END IF;
END $$;

SELECT '013b complete — face descriptor columns and types fixed' AS status;
