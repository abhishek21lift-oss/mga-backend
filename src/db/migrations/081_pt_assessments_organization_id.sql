-- 081_pt_assessments_organization_id.sql
-- Phase 1 (Assessments module). Tenant-scopes pt_assessments. Additive +
-- backfilled; applied by the migration runner on deploy before the org-scoped
-- assessment queries serve.

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_assessments_organization_id ON pt_assessments(organization_id);

-- Backfill from the client's organization (the assessment's true owner).
UPDATE pt_assessments a
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = a.client_id
   AND a.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Fallback: the trainer's organization.
UPDATE pt_assessments a
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = a.trainer_id
   AND a.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Final fallback: the single existing org.
UPDATE pt_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
