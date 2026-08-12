-- 156_mobility_posture_organization_id.sql
-- Phase 1 follow-up: 084_progress_tracking_organization_id.sql tenant-scoped
-- weekly_checkins/strength_logs/progress_photos but missed the two body-
-- assessment tables added by 058_progress_tracking_setup.sql. Their list/patch
-- routes filtered on client_id (or id) alone, with no organization_id guard —
-- a caller who knows or guesses another org's client_id/assessment id could
-- read or edit that org's mobility/posture records. Same additive +
-- backfilled shape as 084, behaviour-preserving for the single existing
-- studio.

-- pt_mobility_performance_assessments ───────────────────────
ALTER TABLE pt_mobility_performance_assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_mobility_performance_assessments_organization_id ON pt_mobility_performance_assessments(organization_id);

UPDATE pt_mobility_performance_assessments m
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = m.client_id
   AND m.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE pt_mobility_performance_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- pt_posture_assessments ─────────────────────────────────────
ALTER TABLE pt_posture_assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_posture_assessments_organization_id ON pt_posture_assessments(organization_id);

UPDATE pt_posture_assessments p
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = p.client_id
   AND p.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE pt_posture_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
