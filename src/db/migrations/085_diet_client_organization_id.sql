-- 085_diet_client_organization_id.sql
-- Phase 1 (Diet module). Tenant-scopes the client-owned diet tables:
-- diet_assignments, nutrition_logs, client_fitness_profiles. The shared
-- reference catalogs (meals, diet_templates, supplements) stay global.
-- Additive + backfilled; behaviour-preserving for the single existing studio.
-- Applied by the migration runner on deploy, before the org-scoped queries serve.

-- diet_assignments ───────────────────────────────────────────
ALTER TABLE diet_assignments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_diet_assignments_organization_id ON diet_assignments(organization_id);

UPDATE diet_assignments da
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = da.client_id
   AND da.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE diet_assignments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- nutrition_logs ─────────────────────────────────────────────
ALTER TABLE nutrition_logs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_nutrition_logs_organization_id ON nutrition_logs(organization_id);

UPDATE nutrition_logs n
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = n.client_id
   AND n.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE nutrition_logs
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- client_fitness_profiles ────────────────────────────────────
ALTER TABLE client_fitness_profiles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_client_fitness_profiles_organization_id ON client_fitness_profiles(organization_id);

UPDATE client_fitness_profiles p
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = p.client_id
   AND p.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE client_fitness_profiles
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
