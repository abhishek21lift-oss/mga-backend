-- 083_pt_goals_organization_id.sql
-- Phase 1 (Goals module). Tenant-scopes pt_goals. Additive + backfilled;
-- behaviour-preserving for the single existing studio. Applied by the
-- migration runner on deploy, before the org-scoped goal queries serve.

ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_goals_organization_id ON pt_goals(organization_id);

-- Backfill from the client's organization (the goal's true owner).
UPDATE pt_goals g
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = g.client_id
   AND g.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE pt_goals
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
