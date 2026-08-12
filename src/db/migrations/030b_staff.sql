-- Creates the staff tables if they don't exist yet.
--
-- Renamed from the unnumbered `staff.sql`, which sorted after every numbered
-- file and therefore ran LAST — while migration 031 adds a unique_id column
-- and trigger to `staff`, so a fresh database aborted there with "relation
-- staff does not exist". The number places it before its first consumer.
--
-- Both statements are CREATE TABLE IF NOT EXISTS, so a database that already
-- applied this under the old filename simply re-runs it as a no-op.

CREATE TABLE IF NOT EXISTS staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  role        TEXT NOT NULL,   -- e.g. Admin, Manager, Trainer, Receptionist, Accountant, HR, Support
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_targets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id            UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  month               TEXT NOT NULL,          -- format: YYYY-MM
  target_revenue      NUMERIC(12,2) DEFAULT 0,
  target_clients      INT DEFAULT 0,
  target_sessions     INT DEFAULT 0,
  achieved_revenue    NUMERIC(12,2) DEFAULT 0,
  achieved_clients    INT DEFAULT 0,
  achieved_sessions   INT DEFAULT 0,
  UNIQUE (staff_id, month)
);
