-- 078_multitenancy_foundation.sql
-- Phase 0 of the multi-tenant SaaS conversion. Establishes the tenant
-- boundary without changing any existing behaviour:
--   1. `organizations` table (the tenant).
--   2. Nullable `organization_id` (FK) on the identity tables users + trainers.
--      Kept NULLABLE during the phased rollout so nothing that inserts a
--      user/trainer today breaks before those paths are made tenant-aware.
--   3. A platform-level `super_admin` role (org-less; manages all tenants).
--      Tenant admins keep role='admin' but are now scoped to one organization.
--   4. Backfill: the single existing studio becomes one organization and its
--      owner user + both coach records are stamped into it.
--
-- Deliberately NOT here (later, dedicated phases): organization_id on the ~50
-- business tables, Row-Level Security policies (need per-request connection
-- handling around the pg pool), and NOT NULL tightening once every write path
-- stamps the column.

-- 1. Organizations (tenants) — the multi-tenant boundary.
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. organization_id on the identity tables (nullable during phased rollout).
ALTER TABLE users    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE trainers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_organization_id    ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_trainers_organization_id ON trainers(organization_id);

-- 3. Platform-level super_admin role.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['super_admin','admin','manager','trainer','reception','member']));

-- 4. Backfill: the one existing studio becomes a single organization.
INSERT INTO organizations (name, slug, status)
SELECT 'Abhishek PT Studio', 'abhishek-pt-studio', 'active'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'abhishek-pt-studio');

UPDATE users u
   SET organization_id = o.id
  FROM organizations o
 WHERE o.slug = 'abhishek-pt-studio'
   AND u.organization_id IS NULL
   AND u.role <> 'super_admin';   -- platform super admins stay org-less

UPDATE trainers t
   SET organization_id = o.id
  FROM organizations o
 WHERE o.slug = 'abhishek-pt-studio'
   AND t.organization_id IS NULL;
