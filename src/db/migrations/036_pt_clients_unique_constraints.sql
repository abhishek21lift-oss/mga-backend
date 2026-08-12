-- Migration 036: add UNIQUE constraints on pt_clients mobile and email
-- The pt_clients table was missing these constraints (present on clients table).
-- Deduplicate existing rows first, then apply constraints.

-- Remove duplicate mobiles: keep the most recently created row per mobile
DELETE FROM pt_clients
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY mobile ORDER BY created_at DESC) AS rn
    FROM pt_clients
    WHERE mobile IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Remove duplicate emails: keep the most recently created row per email
DELETE FROM pt_clients
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at DESC) AS rn
    FROM pt_clients
    WHERE email IS NOT NULL
  ) ranked
  WHERE rn > 1
);

ALTER TABLE pt_clients
  ADD CONSTRAINT pt_clients_mobile_unique UNIQUE (mobile);

CREATE UNIQUE INDEX pt_clients_email_unique
  ON pt_clients (email)
  WHERE email IS NOT NULL;
