-- 080_pt_payments_organization_id.sql
-- Phase 1 (Payments module). Tenant-scopes the pt_payments ledger. Additive +
-- backfilled; behaviour-preserving for the single existing studio. Applied by
-- the migration runner on deploy, before the org-scoped payment queries serve.

ALTER TABLE pt_payments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_payments_organization_id ON pt_payments(organization_id);

-- Backfill from the paying client's organization (the payment's true owner).
UPDATE pt_payments pp
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = pp.client_id
   AND pp.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Fallback for payments with no/unlinked client: the trainer's organization.
UPDATE pt_payments pp
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = pp.trainer_id
   AND pp.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE pt_payments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
