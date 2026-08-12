-- 082_pt_sessions_organization_id.sql
-- Phase 1 (Sessions module). Tenant-scopes pt_sessions. Additive +
-- backfilled; behaviour-preserving for the single existing studio. Applied by
-- the migration runner on deploy, before the org-scoped session queries serve.

ALTER TABLE pt_sessions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_sessions_organization_id ON pt_sessions(organization_id);

-- Backfill from the client's organization (the session's true owner).
UPDATE pt_sessions s
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = s.client_id
   AND s.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Fallback for sessions with no/unlinked client: the trainer's organization.
UPDATE pt_sessions s
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = s.trainer_id
   AND s.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE pt_sessions
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
