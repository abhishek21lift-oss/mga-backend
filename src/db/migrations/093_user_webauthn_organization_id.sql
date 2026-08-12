-- 093_user_webauthn_organization_id.sql
-- Phase 1 (staff passkeys). Tenant-tags user_webauthn_credentials with the
-- owning organization so admin passkey-management views can be scoped per-org
-- and never leak credential metadata across tenants.
--
-- Passkey *authentication* is already tenant-safe: a credential maps to exactly
-- one user_id, and each user belongs to exactly one organization, so a passkey
-- can only ever log its owner into their own account. This column adds the
-- explicit linkage the multi-tenant spec calls for, backs the org-scoped admin
-- queries, and gives us defense-in-depth for tenant filtering.
--
-- Also records the FIDO2 Backup-Eligible (BE) flag alongside the existing
-- Backup-State (backed_up / BS) flag for full credential-provenance coverage.
--
-- Additive + backfilled; behaviour-preserving. Applied by the migration runner
-- on deploy, before the org-scoped admin endpoints serve.

ALTER TABLE user_webauthn_credentials
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE user_webauthn_credentials
  ADD COLUMN IF NOT EXISTS backup_eligible BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_webauthn_creds_organization_id
  ON user_webauthn_credentials(organization_id);

-- Backfill from the owning user's organization.
UPDATE user_webauthn_credentials uc
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = uc.user_id
   AND uc.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

-- Final fallback: the single existing org (correct while one studio exists).
UPDATE user_webauthn_credentials
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;
