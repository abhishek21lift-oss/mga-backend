-- 084_progress_tracking_organization_id.sql
-- Phase 1 (Measurements/Check-ins/Strength/Photos). Tenant-scopes the three
-- client progress-tracking tables. Additive + backfilled; behaviour-preserving
-- for the single existing studio. Applied by the migration runner on deploy,
-- before the org-scoped progress queries serve.

-- weekly_checkins ────────────────────────────────────────────
ALTER TABLE weekly_checkins ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_weekly_checkins_organization_id ON weekly_checkins(organization_id);

UPDATE weekly_checkins w
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = w.client_id
   AND w.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE weekly_checkins
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- strength_logs ──────────────────────────────────────────────
ALTER TABLE strength_logs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_strength_logs_organization_id ON strength_logs(organization_id);

UPDATE strength_logs s
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = s.client_id
   AND s.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE strength_logs
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- progress_photos ────────────────────────────────────────────
ALTER TABLE progress_photos ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_progress_photos_organization_id ON progress_photos(organization_id);

UPDATE progress_photos p
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = p.client_id
   AND p.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE progress_photos
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
