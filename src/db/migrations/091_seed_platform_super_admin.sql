-- 091_seed_platform_super_admin.sql
-- Seeds the platform Super Admin — the org-less account (organization_id NULL,
-- role 'super_admin') that manages all tenants via the hidden /platform portal.
-- The password is stored only as a bcrypt hash (cost 12, generated with the
-- app's bcryptjs); the plaintext was delivered out-of-band and is not in git.
-- Idempotent: does nothing if a super_admin (or this email) already exists.

INSERT INTO public.users (id, name, email, password, role, is_active, token_version, organization_id)
SELECT
  'usr-superadmin-001',
  'Platform Super Admin',
  'superadmin@619studio.com',
  '$2a$12$VesQ3fklKr2SO8c5EUJeHO829tTY7E507qG435B7nUQhwRx8dH69W',
  'super_admin',
  true,
  0,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.users
   WHERE email = 'superadmin@619studio.com' OR role = 'super_admin'
);
