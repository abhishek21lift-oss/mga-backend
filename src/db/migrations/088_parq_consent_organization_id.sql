-- 088_parq_consent_organization_id.sql
-- Phase 1 (PAR-Q / Consent forms). Tenant-scopes the client-owned screening
-- and consent tables: pt_parq_forms, pt_medical_clearances, pt_consent_records,
-- pt_parq_documents, pt_informed_consents. pt_family_medical_history has no
-- client_id and is reached only through its parent pt_parq_forms row, so it is
-- isolated via that gated parent rather than a duplicate column. Additive +
-- backfilled; behaviour-preserving for the single existing studio. Applied by
-- the migration runner on deploy, before the org-scoped queries serve.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pt_parq_forms','pt_medical_clearances','pt_consent_records','pt_parq_documents','pt_informed_consents']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(organization_id)', 'idx_'||t||'_organization_id', t);

    -- Backfill from the client's organization (each table carries client_id).
    EXECUTE format($f$
      UPDATE %I tbl
         SET organization_id = c.organization_id
        FROM pt_clients c
       WHERE c.id = tbl.client_id
         AND tbl.organization_id IS NULL
         AND c.organization_id IS NOT NULL
    $f$, t);

    -- Final fallback: the single existing org (correct while one studio exists).
    EXECUTE format($f$
      UPDATE %I
         SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
       WHERE organization_id IS NULL
         AND (SELECT count(*) FROM organizations) = 1
    $f$, t);
  END LOOP;
END $$;
