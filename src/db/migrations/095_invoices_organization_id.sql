-- 095_invoices_organization_id.sql
-- Phase 1 (Invoices module). Tenant-scopes the invoices table now that its
-- schema is reconciled (094) and the routes work. Invoices are business
-- records; the owning org is resolved from the creating user. Additive +
-- backfilled; behaviour-preserving for the single existing studio. Applied by
-- the migration runner on deploy, before the org-scoped invoice queries serve.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_organization_id ON invoices(organization_id);

-- Backfill from the creating user's organization.
UPDATE invoices i
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = i.created_by
   AND i.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE invoices
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
