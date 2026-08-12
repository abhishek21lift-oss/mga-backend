-- 086_workouts_organization_id.sql
-- Phase 1 (Workouts module). Tenant-scopes the client-owned workout tables:
-- workout_assignments (which client got which plan) and workout_sessions (the
-- logged training sessions). The per-session exercises/sets leaf tables are
-- always reached through a JOIN to workout_sessions, so their isolation is
-- enforced via that join rather than a duplicate column. The shared plan
-- library (workout_plans, workout_exercises, exercises) stays global.
-- Additive + backfilled; behaviour-preserving for the single existing studio.
-- Applied by the migration runner on deploy, before the org-scoped queries serve.

-- workout_assignments ────────────────────────────────────────
ALTER TABLE workout_assignments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workout_assignments_organization_id ON workout_assignments(organization_id);

UPDATE workout_assignments wa
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = wa.client_id
   AND wa.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE workout_assignments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- workout_sessions ───────────────────────────────────────────
ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workout_sessions_organization_id ON workout_sessions(organization_id);

UPDATE workout_sessions ws
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = ws.client_id
   AND ws.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE workout_sessions
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
