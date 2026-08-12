-- ============================================================
-- 031_unique_ids.sql
-- Adds human-readable unique IDs to pt_clients, staff, trainers.
-- Format: PTC-00001 / STF-00001 / TRN-00001
-- ============================================================

-- ── Sequences ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS seq_ptc_id START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_stf_id START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_trn_id START 1 INCREMENT 1;

-- ── Add unique_id columns ─────────────────────────────────────────────
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS unique_id TEXT;
ALTER TABLE staff      ADD COLUMN IF NOT EXISTS unique_id TEXT;
ALTER TABLE trainers   ADD COLUMN IF NOT EXISTS unique_id TEXT;

-- ── Back-fill existing rows ───────────────────────────────────────────
-- PT Clients: PTC-XXXXX
UPDATE pt_clients
   SET unique_id = 'PTC-' || LPAD(nextval('seq_ptc_id')::TEXT, 5, '0')
 WHERE unique_id IS NULL;

-- Staff: STF-XXXXX
UPDATE staff
   SET unique_id = 'STF-' || LPAD(nextval('seq_stf_id')::TEXT, 5, '0')
 WHERE unique_id IS NULL;

-- Trainers: TRN-XXXXX
UPDATE trainers
   SET unique_id = 'TRN-' || LPAD(nextval('seq_trn_id')::TEXT, 5, '0')
 WHERE unique_id IS NULL;

-- ── Triggers to auto-assign on insert ────────────────────────────────
CREATE OR REPLACE FUNCTION assign_ptc_unique_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unique_id IS NULL OR NEW.unique_id = '' THEN
    NEW.unique_id := 'PTC-' || LPAD(nextval('seq_ptc_id')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION assign_stf_unique_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unique_id IS NULL OR NEW.unique_id = '' THEN
    NEW.unique_id := 'STF-' || LPAD(nextval('seq_stf_id')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION assign_trn_unique_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unique_id IS NULL OR NEW.unique_id = '' THEN
    NEW.unique_id := 'TRN-' || LPAD(nextval('seq_trn_id')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END; $$;

-- Drop and recreate triggers idempotently
DROP TRIGGER IF EXISTS trg_ptc_unique_id ON pt_clients;
CREATE TRIGGER trg_ptc_unique_id
  BEFORE INSERT ON pt_clients
  FOR EACH ROW EXECUTE FUNCTION assign_ptc_unique_id();

DROP TRIGGER IF EXISTS trg_stf_unique_id ON staff;
CREATE TRIGGER trg_stf_unique_id
  BEFORE INSERT ON staff
  FOR EACH ROW EXECUTE FUNCTION assign_stf_unique_id();

DROP TRIGGER IF EXISTS trg_trn_unique_id ON trainers;
CREATE TRIGGER trg_trn_unique_id
  BEFORE INSERT ON trainers
  FOR EACH ROW EXECUTE FUNCTION assign_trn_unique_id();

-- ── Unique constraints (after back-fill so no duplicates exist) ───────
ALTER TABLE pt_clients DROP CONSTRAINT IF EXISTS pt_clients_unique_id_key;
ALTER TABLE pt_clients ADD CONSTRAINT pt_clients_unique_id_key UNIQUE (unique_id);

ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_unique_id_key;
ALTER TABLE staff ADD CONSTRAINT staff_unique_id_key UNIQUE (unique_id);

ALTER TABLE trainers DROP CONSTRAINT IF EXISTS trainers_unique_id_key;
ALTER TABLE trainers ADD CONSTRAINT trainers_unique_id_key UNIQUE (unique_id);
