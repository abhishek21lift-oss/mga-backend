-- 166_member_domain.sql
--
-- Phase 2 of the GMS transformation: the canonical member.
--
-- See docs/GMS_TARGET_ARCHITECTURE.md §2. The short version: a member is a
-- person who belongs to the gym; a PT client is a member who has also bought
-- personal training. Today they are the same row, so `pt_clients` carries
-- trainer_id, package_type, monthly_pt_amount and trainer_commission on the
-- person record, and there is no way to represent someone who pays for gym
-- access and never meets a trainer. That is most of a real gym's roster.
--
-- This migration creates the person table, links pt_clients to it, and
-- backfills. It does not move a single column out of pt_clients: after this
-- runs, every existing PT query still works exactly as before.
--
-- ── The legacy `members` table, and why this is a rename ────────────────────
--
-- There is already a table called `members`. It is the abandoned v3 attempt:
-- 0 rows, 0 organisations represented, no organization_id column, its endpoint
-- deleted. src/db/migrations/MEMBERS-TENANT-GAP.md holds the read-only
-- production verification that settled it.
--
-- src/__tests__/membersEndpointRemoved.test.js guards that table, and its own
-- comment says why the guard exists and what would justify lifting it:
--
--     "The table is empty but not orphaned, and dropping a table was never
--      part of this. A migration doing so would be a separate, larger
--      decision."
--
-- This is that decision, and it is deliberately the smallest version of it: a
-- RENAME, not a DROP. Nothing is destroyed, the guard's DROP/TRUNCATE assertion
-- is not weakened, and the whole thing reverses with
--
--     ALTER TABLE legacy_members_v3 RENAME TO members;
--
-- `member_memberships.member_id` keeps its foreign key without any change here:
-- Postgres tracks the constraint by OID, so it follows the rename. Both tables
-- are replaced together in Phase 3, which is when they can actually go.
--
-- ── Why the new table is built rather than the old one adopted ──────────────
--
-- The old one cannot be tenanted usefully. Migration 015 declared its
-- `client_id` as TEXT NOT NULL DEFAULT '' and members.service.js never set it,
-- so its rows could not be attributed to a studio by joining anything —
-- MEMBERS-TENANT-GAP.md works through this. Migration 157 discovers tables for
-- RLS *by* the organization_id column, so a table without one is outside the
-- boundary permanently. Rebuilding costs nothing because there is nothing in it.
--
-- ── Uniqueness is tenant-scoped, deliberately ───────────────────────────────
--
-- V-15 in TENANT_SECURITY_AUDIT.md: pt_plans declares `name TEXT NOT NULL
-- UNIQUE`, so two studios cannot both have a package called "Basic PT". Every
-- constraint below is scoped by organization_id so that class of bug is not
-- reproduced in the newest table in the schema.

-- ── 1. Move the abandoned table out of the way ──────────────────────────────
DO $rename$
BEGIN
  IF to_regclass('public.members') IS NOT NULL
     AND to_regclass('public.legacy_members_v3') IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'members'
          AND column_name = 'organization_id'
     )
  THEN
    -- The organization_id check is the discriminator: the legacy table has no
    -- such column and the new one below has it NOT NULL. So on a database where
    -- this migration has already run, `members` is the new table and this block
    -- correctly does nothing. Idempotent, and safe to re-run.
    ALTER TABLE members RENAME TO legacy_members_v3;

    -- Rename the constraint too. RENAME TABLE does not touch constraint names,
    -- so the old table keeps `members_pkey` and the new one below is assigned
    -- `members_pkey1` by Postgres. That works and is purely cosmetic, but a
    -- primary key called members_pkey1 on a table called members, next to a
    -- members_pkey belonging to something else, is exactly the kind of detail
    -- that costs somebody an hour in three months.
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_pkey'
                 AND conrelid = 'public.legacy_members_v3'::regclass) THEN
      ALTER TABLE legacy_members_v3 RENAME CONSTRAINT members_pkey TO legacy_members_v3_pkey;
    END IF;

    RAISE NOTICE '[166] legacy `members` renamed to legacy_members_v3 (0 rows expected; see MEMBERS-TENANT-GAP.md).';
  END IF;
END $rename$;

-- ── 2. The canonical member ─────────────────────────────────────────────────
--
-- id is TEXT, matching pt_clients.id (migration 017 declares it "TEXT PRIMARY
-- KEY DEFAULT gen_random_uuid()::TEXT"). Homogeneous keys across the two tables
-- keep every join and foreign key between them plain, and 119_pt_leads.sql
-- already names this as the convention to follow.
--
-- organization_id is NOT NULL from birth. Retrofitting it later is what
-- 155_organization_id_not_null.sql exists to clean up, and this table has no
-- history to be compatible with.
CREATE TABLE IF NOT EXISTS members (
  id                 TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id    UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  member_code        TEXT,

  name               TEXT         NOT NULL,
  mobile             TEXT,
  email              TEXT,
  dob                DATE,
  gender             TEXT,
  address            TEXT,
  photo_url          TEXT,

  emergency_contact  TEXT,
  emergency_phone    TEXT,

  -- prospect: converted from a lead but not yet paid for anything.
  -- active/inactive/expired/cancelled track the gym relationship, NOT a
  -- membership's own status — a member with a lapsed membership is `expired`
  -- here and keeps their history, attendance and PT enrollments.
  status             TEXT         NOT NULL DEFAULT 'active'
                     CHECK (status IN ('prospect','active','inactive','expired','cancelled')),

  joined_on          DATE,
  -- How this person entered the system. 'pt' marks the rows this migration
  -- backfills from pt_clients, so the backfill stays identifiable afterwards.
  source             TEXT         NOT NULL DEFAULT 'walk-in'
                     CHECK (source IN ('walk-in','lead','import','pt','portal','other')),
  notes              TEXT,

  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_organization_id ON members(organization_id);
CREATE INDEX IF NOT EXISTS idx_members_status          ON members(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_members_name            ON members(organization_id, lower(name));

-- Partial uniques: a soft-deleted row must not block a new member reusing the
-- same phone number or code, which is the whole point of soft deletion.
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_code
  ON members(organization_id, member_code) WHERE deleted_at IS NULL AND member_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_mobile
  ON members(organization_id, mobile) WHERE deleted_at IS NULL AND mobile IS NOT NULL;

-- 149_client_uniqueness_is_per_org.sql made the same call for pt_clients.

-- ── 3. Row Level Security, house pattern ────────────────────────────────────
--
-- Deny-all rather than an organization-scoped policy, matching all 168 other
-- tables. The API connects as the table owner and bypasses RLS entirely; these
-- policies exist to make the anon/authenticated PostgREST keys inert. See
-- 148_staff_tables_rls.sql, which sets out why this is the deliberate house
-- pattern and not an oversight, and db/migrations/TENANT-RLS-PLAN.md for the
-- org-scoped policies that replace it when the app_tenant role lands.
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON members FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'members'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON members
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- ── 4. Link PT clients to their member ──────────────────────────────────────
--
-- Nullable here and tightened only after the backfill is verified — the
-- check-then-tighten shape 155_organization_id_not_null.sql established, so one
-- unattributable row degrades to a warning instead of taking the deploy down.
-- migrate.js runs on every boot.
--
-- ON DELETE RESTRICT, not CASCADE: deleting a member must not silently take
-- their PT history — payments, sessions, assessments and progress all hang off
-- pt_clients. The application soft-deletes; a hard delete of a member with an
-- enrollment should fail loudly and be dealt with deliberately.
ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS member_id TEXT REFERENCES members(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_pt_clients_member_id ON pt_clients(member_id);

-- ── 5. Backfill: one member per existing PT client ──────────────────────────
--
-- Every existing pt_clients row is a real person who belongs to the studio, so
-- each gets exactly one member. Identity fields are copied UP into members;
-- nothing is removed from pt_clients.
--
-- Deduplication is deliberately NOT attempted. Two pt_clients rows that are the
-- same human stay two members, and the product's existing merge surface
-- (/settings/merge-duplicates, POST /api/pt-os/clients/merge-duplicates) is
-- extended to members afterwards. Fuzzy identity matching inside a migration,
-- against six live studios, is how records get merged wrong silently.
--
-- Guarded on member_id IS NULL so re-running adds nothing.
--
-- ── Why this is a loop and not one INSERT ... SELECT ────────────────────────
--
-- A set-based version has to pair each new member back to the client it came
-- from, and `INSERT ... RETURNING` gives back the new ids without saying which
-- source row produced each one. The available correlation keys — (organization,
-- name, created_at) — are unique in practice and guaranteed by no constraint.
-- Two clients enrolled in the same second with the same name would be paired
-- arbitrarily, and the failure is silent: both rows get a member, one member
-- holds the wrong person's history forever.
--
-- One INSERT per row with `RETURNING id INTO` removes the question. This runs
-- once, over six studios' clients, inside a single migration — the cost is
-- irrelevant next to getting the pairing provably right.
--
-- ── The mobile collision, and what it can and cannot be ─────────────────────
--
-- NOT two pt_clients sharing a number. 149_client_uniqueness_is_per_org.sql
-- declares
--
--     CREATE UNIQUE INDEX pt_clients_org_mobile_unique
--       ON pt_clients (organization_id, mobile)
--       WHERE mobile IS NOT NULL AND mobile <> '';
--
-- with no deleted_at predicate, so within one studio that is already
-- impossible, soft-deleted rows included. The source cannot produce a
-- duplicate.
--
-- The case that CAN happen is a member created through /api/members who later
-- enrols in PT, or any re-run of this migration once that API has been in use:
-- `members` already holds the number, `pt_clients` holds an unlinked row with
-- the same one. uq_members_org_mobile is partial on deleted_at IS NULL — unlike
-- the source index — because a soft-deleted member must not block a new one
-- reusing the number, so the two constraints are deliberately not identical.
--
-- When it happens the later member is created with mobile NULL and reported,
-- rather than the migration failing or silently unifying two people. Merging is
-- the merge tool's decision, not this file's.
DO $backfill$
DECLARE
  c          RECORD;
  new_id     TEXT;
  mobile_val TEXT;
  collisions bigint := 0;
  created    bigint := 0;
BEGIN
  FOR c IN
    SELECT * FROM pt_clients
     WHERE member_id IS NULL AND organization_id IS NOT NULL
     ORDER BY created_at, id
  LOOP
    mobile_val := NULLIF(c.mobile, '');

    IF mobile_val IS NOT NULL AND EXISTS (
      SELECT 1 FROM members
       WHERE organization_id = c.organization_id
         AND mobile = mobile_val
         AND deleted_at IS NULL
    ) THEN
      mobile_val := NULL;
      collisions := collisions + 1;
    END IF;

    INSERT INTO members (
      organization_id, name, mobile, email, dob, gender, address, photo_url,
      emergency_contact, emergency_phone, status, joined_on, source, created_at
    ) VALUES (
      c.organization_id,
      c.name,
      mobile_val,
      NULLIF(c.email, ''),
      -- Copied straight across: 033_schema_fixes.sql already converted
      -- pt_clients.dob and joining_date from TEXT to DATE
      -- (ALTER COLUMN dob TYPE DATE USING NULLIF(TRIM(dob), '')::DATE), so
      -- there is no string left to parse defensively here. An earlier draft of
      -- this migration guarded them with a `~ '^\d{4}-\d{2}-\d{2}$'` regex,
      -- which is not merely redundant — `date ~ unknown` has no operator in
      -- Postgres and raises at plan time. It survived a fresh-install run only
      -- because pt_clients was empty and PL/pgSQL never planned the loop body.
      -- The first real row would have taken the migration, and with it the
      -- deploy, down. Tested against Postgres 16 with seeded rows.
      c.dob,
      NULLIF(c.gender, ''),
      NULLIF(c.address, ''),
      NULLIF(c.photo_url, ''),
      NULLIF(c.emergency_contact, ''),
      NULLIF(c.emergency_phone, ''),
      CASE WHEN c.deleted_at IS NOT NULL THEN 'inactive'
           WHEN c.status = 'active'      THEN 'active'
           WHEN c.status = 'pending'     THEN 'prospect'
           ELSE 'inactive' END,
      c.joining_date,
      'pt',
      c.created_at
    )
    RETURNING id INTO new_id;

    UPDATE pt_clients SET member_id = new_id WHERE id = c.id;
    created := created + 1;
  END LOOP;

  RAISE NOTICE '[166] Created % member(s) from pt_clients.', created;
  IF collisions > 0 THEN
    RAISE NOTICE '[166] % member(s) created without a mobile because another member in the same studio already had it. These are duplicate people — resolve them with the merge tool, not by hand.', collisions;
  END IF;
END $backfill$;

-- ── 6. Member codes for the backfilled rows ─────────────────────────────────
--
-- Per-organization sequential, assigned in one statement so no advisory lock is
-- needed here — the runtime path in routes/members.js is the one that needs it.
--
-- Numbered from MAX + 1 per organization, NOT from 1. MEMBERS-TENANT-GAP.md
-- records this as one of the three defects in the deleted createMemberCode():
--
--     "the code came from COUNT(*) + 1, which is not a sequence: delete one
--      member and the next code collides with one that already exists"
--
-- The same trap catches a backfill that numbers only the rows it is filling.
-- Any member created through /api/members before this runs — or on any re-run —
-- already holds M00001, and row_number() starting at 1 collides with it on
-- uq_members_org_code. Caught by seeding a pre-existing member and re-running;
-- an empty-table test passes either version.
UPDATE members m
   SET member_code = 'M' || lpad((base.max_n + seq.n)::TEXT, 5, '0')
  FROM (
    SELECT id, organization_id,
           row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS n
      FROM members
     WHERE member_code IS NULL
  ) seq
  JOIN LATERAL (
    SELECT COALESCE(MAX(CAST(SUBSTRING(member_code FROM 2) AS INTEGER)), 0) AS max_n
      FROM members existing
     WHERE existing.organization_id = seq.organization_id
       AND existing.member_code ~ '^M[0-9]+$'
  ) base ON TRUE
 WHERE m.id = seq.id
   AND m.member_code IS NULL;

-- ── 7. Verify and report ────────────────────────────────────────────────────
--
-- NOTICE, not EXCEPTION: migrate.js aborts the whole run on first failure and
-- runs on every boot, so refusing to start the API over one unpaired historical
-- row would turn a data-quality problem into an outage. Same reasoning as
-- 155_organization_id_not_null.sql and 165.
--
-- pt_clients.member_id is NOT tightened to NOT NULL here. That happens in a
-- follow-up once this reports clean on production, deliberately as a separate
-- deployable step.
DO $verify$
DECLARE
  unlinked   bigint;
  orgless    bigint;
  mismatched bigint;
  total      bigint;
BEGIN
  SELECT count(*) INTO total FROM pt_clients;
  SELECT count(*) INTO unlinked FROM pt_clients WHERE member_id IS NULL AND organization_id IS NOT NULL;
  SELECT count(*) INTO orgless  FROM pt_clients WHERE organization_id IS NULL;
  SELECT count(*) INTO mismatched
    FROM pt_clients c JOIN members m ON m.id = c.member_id
   WHERE c.organization_id IS DISTINCT FROM m.organization_id;

  RAISE NOTICE '[166] pt_clients: % total, % linked to a member.', total, total - unlinked - orgless;

  IF unlinked > 0 THEN
    RAISE NOTICE '[166] % pt_clients row(s) have an organization but no member. Pair them by hand before member_id can be tightened to NOT NULL.', unlinked;
  END IF;
  IF orgless > 0 THEN
    RAISE NOTICE '[166] % pt_clients row(s) have no organization_id at all and were skipped — a member cannot be created without a studio to own it. See 155.', orgless;
  END IF;
  IF mismatched > 0 THEN
    -- This one is a real invariant break: the architecture keeps
    -- pt_clients.organization_id denormalised alongside members.organization_id
    -- so ~30 existing orgWhere() predicates stay correct, and the two must agree.
    RAISE WARNING '[166] % pt_clients row(s) disagree with their member on organization_id. This breaks the tenancy invariant and must be resolved.', mismatched;
  END IF;
  IF unlinked = 0 AND orgless = 0 AND mismatched = 0 THEN
    RAISE NOTICE '[166] Member domain backfill clean. pt_clients.member_id can be tightened to NOT NULL.';
  END IF;
END $verify$;
