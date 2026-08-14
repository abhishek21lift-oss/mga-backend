-- 167_organization_settings_and_branches.sql
--
-- Phase 2a. Gives each studio its own configuration, and turns branches into a
-- real tenant-owned entity.
--
-- This closes V-06 in TENANT_SECURITY_AUDIT.md, the largest single defect in
-- that document: `system_settings` is ONE global key/value table with no
-- organization_id, so today all six studios share one studio name, one address,
-- one currency, one timezone, one set of check-in and geofence settings, one
-- set of role permissions, and one list of branches. Any admin editing any of
-- it edits it for everybody.
--
-- It also unblocks the rest of the roadmap. Memberships need per-studio tax and
-- currency defaults, POS needs receipt prefixes, lockers need rental defaults
-- and notifications need per-studio sender identity. docs/GMS_TARGET_
-- ARCHITECTURE.md §8 promoted this ahead of the membership domain for that
-- reason.
--
-- ── Two different migrations, because the two kinds of row differ ───────────
--
-- CONFIGURATION keys are shared BY DESIGN. Every studio reads the same
-- `currency` row today, so copying that row's value to every organization
-- changes nothing for anyone — it is exactly behaviour-preserving, and needs no
-- production count to justify. That is what makes this different from the
-- sixteen tables TENANT_SECURITY_AUDIT.md §5 gates on a count: there, a row
-- belongs to one studio and nothing says which. Here, a row belongs to all of
-- them and always did.
--
-- BRANCHES are the opposite. `branch_<uuid>` rows each belong to exactly one
-- studio — the one whose admin created it — and fanning them out would give
-- every studio a copy of every other studio's branches. They can be attributed
-- exactly, though, and without guessing: POST /api/settings/branches has always
-- written `updated_by = req.user.id`, so the creator is on the row and
-- users.organization_id gives the studio.
--
-- ── system_settings is left in place ───────────────────────────────────────
--
-- Not dropped, not emptied. The rows stay exactly as they are, and the routes
-- stop reading them. That keeps this reversible by reverting code rather than
-- by restoring data, which is the property worth having on the change that
-- touches every studio's configuration at once.

-- ── 1. Per-studio configuration ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_settings (
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT        NOT NULL,
  value           TEXT,
  type            TEXT        NOT NULL DEFAULT 'string'
                  CHECK (type IN ('string','number','boolean','json')),
  description     TEXT,
  updated_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, key)
);

CREATE INDEX IF NOT EXISTS idx_organization_settings_org ON organization_settings(organization_id);

ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organization_settings FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_settings'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON organization_settings
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 2. Branches become a tenant-owned entity ────────────────────────────────
--
-- The `branches` table already exists and has the right shape (id, name, code,
-- address, phone, email, manager, is_active). It has been orphaned since
-- schema.sql — nothing writes it, and the only reader is a name-resolution join
-- in lib/google-calendar.js. docs/LEGACY_SYSTEM_INVENTORY.md classified it KEEP
-- for exactly this: adopt the table rather than invent a second one.
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_branches_organization_id ON branches(organization_id);

-- Tenant-scoped, never global: V-15 is the same defect on pt_plans, where a
-- bare UNIQUE(name) means two studios cannot both have a branch called "Main".
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_org_name
  ON branches(organization_id, lower(name)) WHERE deleted_at IS NULL;

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON branches FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'branches'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON branches
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 3. Fan configuration out to every studio ────────────────────────────────
--
-- Every key EXCEPT branch_* and internal_*. Each organization gets its own copy
-- of the value it is already reading, so no studio's behaviour changes.
--
-- internal_* is excluded because routes/settings.js already treats that prefix
-- as operator-only (RESTRICTED_PREFIXES), which is the closest thing this table
-- has to a platform-global marker. Those rows stay in system_settings.
--
-- ON CONFLICT DO NOTHING: a studio that has already been given a key by a
-- previous run, or by the API after this ships, keeps its own value. A re-run
-- must never overwrite a studio's real setting with the old shared default.
INSERT INTO organization_settings (organization_id, key, value, type, description, updated_at)
SELECT o.id, s.key, s.value, s.type, s.description, NOW()
  FROM organizations o
 CROSS JOIN system_settings s
 WHERE s.key NOT LIKE 'branch\_%'
   AND s.key NOT LIKE 'internal\_%'
ON CONFLICT (organization_id, key) DO NOTHING;

-- ── 4. Attribute and migrate branches ───────────────────────────────────────
--
-- Each branch_<uuid> row carries a JSON value {name, location, status} and an
-- updated_by naming the admin who created it. That admin's organization owns
-- the branch. No guessing, and no fan-out.
--
-- The old key is preserved in branches.code so that users.branch_id — which
-- holds the full `branch_<uuid>` string and drives middleware/branch-scope.js —
-- can still be resolved to the new row. Dropping that link would silently
-- unscope every branch-restricted staff account.
DO $branches$
DECLARE
  r            RECORD;
  owner_org    UUID;
  sole_org     UUID;
  org_count    bigint;
  migrated     bigint := 0;
  unattributed bigint := 0;
BEGIN
  IF to_regclass('public.system_settings') IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO org_count FROM organizations;
  IF org_count = 1 THEN SELECT id INTO sole_org FROM organizations; END IF;

  FOR r IN
    SELECT key, value, updated_by FROM system_settings
     WHERE key LIKE 'branch\_%' AND type = 'json'
  LOOP
    -- Skip anything a previous run already moved.
    IF EXISTS (SELECT 1 FROM branches WHERE code = r.key) THEN CONTINUE; END IF;

    SELECT u.organization_id INTO owner_org
      FROM users u WHERE u.id = r.updated_by;

    -- Single-studio fallback, the same shape 088 and 156 use: correct while
    -- only one studio exists, and a no-op on a platform that has more.
    IF owner_org IS NULL THEN owner_org := sole_org; END IF;

    IF owner_org IS NULL THEN
      unattributed := unattributed + 1;
      CONTINUE;
    END IF;

    INSERT INTO branches (id, organization_id, name, code, address, is_active)
    VALUES (
      gen_random_uuid()::TEXT,
      owner_org,
      COALESCE(NULLIF((r.value::jsonb)->>'name', ''), 'Branch'),
      r.key,
      NULLIF((r.value::jsonb)->>'location', ''),
      COALESCE((r.value::jsonb)->>'status', 'active') = 'active'
    )
    ON CONFLICT DO NOTHING;

    migrated := migrated + 1;
  END LOOP;

  IF migrated > 0 THEN
    RAISE NOTICE '[167] Migrated % branch(es) out of system_settings and attributed them by their creator.', migrated;
  END IF;
  IF unattributed > 0 THEN
    -- Fail-closed: an unattributed branch is now invisible to every studio
    -- rather than visible to all of them. Safe, but it is data somebody owns,
    -- so it must be said rather than discovered.
    RAISE NOTICE '[167] % branch(es) could not be attributed to a studio (creator unknown, and more than one organization exists). They remain in system_settings and are no longer served. Attribute them by hand.', unattributed;
  END IF;
END $branches$;

-- ── 5. Report ───────────────────────────────────────────────────────────────
DO $report$
DECLARE orgs bigint; keys bigint; rows_made bigint; br bigint;
BEGIN
  SELECT count(*) INTO orgs FROM organizations;
  SELECT count(*) INTO keys FROM system_settings
   WHERE key NOT LIKE 'branch\_%' AND key NOT LIKE 'internal\_%';
  SELECT count(*) INTO rows_made FROM organization_settings;
  SELECT count(*) INTO br FROM branches WHERE organization_id IS NOT NULL;

  RAISE NOTICE '[167] % studio(s) x % shared key(s) -> % organization_settings row(s); % tenant-owned branch(es).',
    orgs, keys, rows_made, br;
END $report$;
