-- 089_expenses_organization_id.sql
-- Phase 1 (Expenses module). Tenant-scopes the expenses table. Expenses are
-- business records with no client — the owning org is resolved from the
-- creating user. Additive + backfilled; behaviour-preserving for the single
-- existing studio. Applied by the migration runner on deploy, before the
-- org-scoped expense queries serve.
--
-- Note: the `invoices` table is intentionally NOT touched here. Its live schema
-- (006_premium_features: member_id/invoice_number) does not match what
-- src/routes/invoices.js writes (client_id/invoice_no/amount), so those write
-- routes are a pre-existing runtime mismatch; tenant-scoping is deferred until
-- that schema is reconciled.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_organization_id ON expenses(organization_id);

-- Backfill from the creating user's organization.
UPDATE expenses e
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = e.created_by
   AND e.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE expenses
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
