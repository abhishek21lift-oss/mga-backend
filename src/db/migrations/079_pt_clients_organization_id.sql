-- 079_pt_clients_organization_id.sql
-- Phase 1 (Clients module) of the multi-tenant rollout. Tenant-scopes the
-- client root table pt_clients. Additive + backfilled — no behaviour change
-- for the single existing studio (all its clients map to its one org).
--
-- Applied automatically by the migration runner on deploy (before the server
-- serves traffic), so the org-filtered client queries that ship in the same
-- release always find the column present.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_clients_organization_id ON pt_clients(organization_id);

-- Backfill from the owning trainer's organization.
UPDATE pt_clients c
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = c.trainer_id
   AND c.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Any client with no/unlinked trainer falls back to the single existing org
-- (correct while only one studio exists; new orgs stamp org at insert time).
UPDATE pt_clients
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
