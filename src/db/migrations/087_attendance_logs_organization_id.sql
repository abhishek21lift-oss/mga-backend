-- 087_attendance_logs_organization_id.sql
-- Phase 1 (Attendance module). Tenant-scopes attendance_logs. The table is
-- polymorphic (ref_type + ref_id), so the org is resolved from the referenced
-- entity: a client ref via pt_clients, a trainer ref via trainers. Additive +
-- backfilled; behaviour-preserving for the single existing studio. Applied by
-- the migration runner on deploy, before the org-scoped attendance queries serve.

ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_logs_organization_id ON attendance_logs(organization_id);

-- Client check-ins: resolve org from the referenced pt_clients row.
UPDATE attendance_logs a
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE a.ref_type = 'client'
   AND c.id = a.ref_id
   AND a.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Trainer check-ins: resolve org from the referenced trainer row.
UPDATE attendance_logs a
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE a.ref_type = 'trainer'
   AND t.id = a.ref_id
   AND a.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE attendance_logs
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
