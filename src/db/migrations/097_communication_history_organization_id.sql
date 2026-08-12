-- 097_communication_history_organization_id.sql
-- Tenant-scopes the communication_history log (sent announcements + recipient
-- counts). Without an owning org the /api/communication/history reads returned
-- every studio's sent messages to every admin. Additive + backfilled from the
-- sending user's org; behaviour-preserving for the single existing studio.
-- Applied by the migration runner on deploy, before the org-scoped queries serve.

ALTER TABLE communication_history ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_communication_history_organization_id ON communication_history(organization_id);

-- Backfill from the sending user's organization.
UPDATE communication_history ch
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = ch.sent_by
   AND ch.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE communication_history
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
