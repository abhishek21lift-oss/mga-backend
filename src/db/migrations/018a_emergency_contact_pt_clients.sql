-- ============================================================
-- 018_emergency_contact_pt_clients.sql
-- Adds emergency_contact to pt_clients and migrates data.
-- ============================================================

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS emergency_contact TEXT;

-- Migrate existing emergency_contact from main clients table
UPDATE pt_clients pt
SET emergency_contact = c.emergency_contact,
    updated_at = NOW()
FROM clients c
WHERE pt.id = c.id
  AND c.emergency_contact IS NOT NULL
  AND pt.emergency_contact IS NULL;
