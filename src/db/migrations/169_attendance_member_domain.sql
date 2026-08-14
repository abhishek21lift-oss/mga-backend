-- 169_attendance_member_domain.sql
--
-- Let a gym member check in.
--
-- Attendance is the one domain the audit scored 70 before any of this work
-- started, and the score was fair: attendance_logs is already tenant-scoped
-- (087 added organization_id), already polymorphic on ref_type, already
-- branch-aware, and the register, stats and gaps endpoints all work. It was
-- never the mechanism that was PT-bound.
--
-- What was PT-bound is who is allowed to appear in it. The ref_type CHECK
-- admits 'client', 'trainer', 'staff' and 'user' — the four kinds of person a
-- PT studio has. A gym member is none of them, so in a system whose central
-- daily event is a member walking through the door, that event could not be
-- recorded. Not badly recorded: not recordable. INSERT raised a check
-- violation.
--
-- So this migration is small, and that is the finding rather than a caveat.
-- Phase 4 was budgeted as a rebuild and is an ALTER, because the v4 schema's
-- polymorphic design was right and only its enumeration of person-kinds was
-- narrow.
--
-- ── Two changes, and one thing deliberately left alone ──────────────────────
--
--   1. 'member' becomes a valid ref_type.
--   2. member_id — a real foreign key, alongside the polymorphic ref_id rather
--      than instead of it, so nothing that reads ref_id/ref_type changes.
--
-- Row Level Security is the thing left alone, and the section at the bottom
-- explains why at length: this table already has it, from a migration that
-- grep cannot see.

-- ── 1. 'member' is a person who can attend ──────────────────────────────────
--
-- Rewritten wholesale rather than added to, because a CHECK constraint has no
-- ALTER … ADD VALUE the way an enum type does. The list is the same as
-- 025_qr_checkin.sql's plus 'member', and DROP … IF EXISTS keeps this
-- idempotent across the reruns migrate.js performs on every boot.
ALTER TABLE attendance_logs
  DROP CONSTRAINT IF EXISTS attendance_logs_ref_type_check;

ALTER TABLE attendance_logs
  ADD CONSTRAINT attendance_logs_ref_type_check
  CHECK (ref_type IN ('client', 'trainer', 'staff', 'user', 'member'));

-- ── 2. A real foreign key for members ───────────────────────────────────────
--
-- ref_id stays exactly what it is: a TEXT id whose meaning depends on ref_type,
-- with no FK, because it points into four different tables. Every existing
-- query filters on it and none of them change.
--
-- member_id is added beside it and carries the integrity ref_id cannot. For a
-- member check-in both hold the same value; the UNIQUE (ref_id, ref_type, date)
-- constraint therefore still means "one attendance row per member per day",
-- which is what the ON CONFLICT clause in routes/attendance.js relies on.
--
-- ON DELETE RESTRICT, matching pt_clients.member_id in 166 and memberships in
-- 168. A member's attendance is their history with the gym; a hard delete that
-- silently took it would be the deletion of a record someone may be required
-- to keep. The application soft-deletes.
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS member_id TEXT;

-- The two columns must agree: member_id is present exactly when ref_type says
-- this row is a member's. Without this the column is decorative — a row could
-- claim ref_type 'member' with a NULL member_id and no join would find it, or
-- carry a member_id while typed as a trainer.
--
-- Added NOT VALID and validated separately. Both statements succeed on every
-- existing row (they are all client/trainer/staff/user with member_id NULL, so
-- the equality is false = false), but attendance_logs is the largest table in a
-- busy studio and NOT VALID takes only a brief ACCESS EXCLUSIVE lock while
-- VALIDATE CONSTRAINT scans under a lock that does not block reads or writes.
-- On a fresh database the distinction is invisible; on a live one it is the
-- difference between a pause and an outage.
-- organization_id is in the constraint alongside member_id, and that is what
-- makes the composite foreign key below actually bite. A composite FK is MATCH
-- SIMPLE by default: if ANY of its columns is NULL the row is not checked at
-- all, so a member row with a NULL organization_id would slip past the tenant
-- FK entirely — the one case it exists to catch.
--
-- On a fresh database this clause is redundant, and it is worth being precise
-- about why it is kept anyway. 087 added organization_id as nullable; 155
-- tightens it to NOT NULL — but conditionally, per its check-then-tighten
-- discipline, SKIPPING any table that still holds NULL rows and warning
-- instead. So "attendance_logs.organization_id is NOT NULL" is true of a clean
-- install and NOT guaranteed of a production database that had unattributable
-- rows when 155 ran. This constraint is what closes that gap for the rows this
-- migration introduces: whatever 155 managed for the table's history, a member
-- check-in from here on cannot be orphaned from its studio.
DO $ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'attendance_logs'::regclass
       AND conname  = 'attendance_logs_member_ref_agree'
  ) THEN
    ALTER TABLE attendance_logs
      ADD CONSTRAINT attendance_logs_member_ref_agree
      CHECK (
        (ref_type = 'member') = (member_id IS NOT NULL)
        AND (ref_type <> 'member' OR organization_id IS NOT NULL)
      )
      NOT VALID;
  END IF;
END $ck$;

DO $validate$
BEGIN
  -- convalidated is false only between the two statements above and here, so on
  -- a rerun this is a no-op rather than a repeated full scan.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'attendance_logs'::regclass
       AND conname  = 'attendance_logs_member_ref_agree'
       AND NOT convalidated
  ) THEN
    ALTER TABLE attendance_logs VALIDATE CONSTRAINT attendance_logs_member_ref_agree;
    RAISE NOTICE '[169] validated attendance_logs_member_ref_agree';
  END IF;
END $validate$;

-- ── The tenant foreign key ──────────────────────────────────────────────────
--
-- A plain `REFERENCES members(id)` says the member exists. It does not say the
-- member is THIS studio's, and that is the failure worth preventing: verified
-- against a real database, an INSERT putting studio B's member into studio A's
-- organization_id was accepted without complaint. The row never leaks on read,
-- because every SELECT carries the organization predicate — studio A simply
-- accumulates attendance for a person they have never met, in a register they
-- can see, and studio B's member count is quietly wrong.
--
-- routes/attendance.js does guard this (memberInOrg, on all three write paths).
-- A guard in one file is a guard until someone adds a fourth path, or a bulk
-- importer, or a worker. Referential integrity is not something an application
-- should be the only enforcer of when the database can hold the invariant
-- itself, so the FK is over the PAIR:
--
--     (member_id, organization_id) → members (id, organization_id)
--
-- After which a cross-tenant attendance row is not merely rejected by policy,
-- it is unrepresentable.
--
-- The redundant single-column FK is dropped: the composite subsumes it (for a
-- member row both columns are NOT NULL by the constraint above, so MATCH SIMPLE
-- always checks), and leaving both means two constraint violations for one
-- mistake and two indexes to maintain on every write.
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_id_org ON members (id, organization_id);

ALTER TABLE attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_member_id_fkey;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'attendance_logs'::regclass
       AND conname  = 'attendance_logs_member_org_fkey'
  ) THEN
    -- RESTRICT, matching pt_clients.member_id in 166 and memberships in 168: a
    -- member's attendance is their history with the gym, and a hard delete that
    -- silently took it would destroy a record someone may be required to keep.
    -- The application soft-deletes.
    ALTER TABLE attendance_logs
      ADD CONSTRAINT attendance_logs_member_org_fkey
      FOREIGN KEY (member_id, organization_id)
      REFERENCES members (id, organization_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'attendance_logs'::regclass
       AND conname  = 'attendance_logs_member_org_fkey'
       AND NOT convalidated
  ) THEN
    ALTER TABLE attendance_logs VALIDATE CONSTRAINT attendance_logs_member_org_fkey;
    RAISE NOTICE '[169] validated attendance_logs_member_org_fkey';
  END IF;
END $fk$;

-- ── Indexes for the two queries a gym actually runs ─────────────────────────
--
-- "Who is in the building today" and "when did this member last come in" are
-- the whole of front-desk attendance. idx_attendance_logs_date already exists
-- from 046 as (date DESC, ref_type), which serves neither well once the table
-- holds more than one studio: it has no organization_id, so every studio's
-- daily register scans every studio's rows and filters after the fact.
CREATE INDEX IF NOT EXISTS idx_attendance_logs_org_date
  ON attendance_logs (organization_id, date DESC, ref_type);

-- Partial, because it answers a question only about members and the majority
-- of rows in an established PT studio are not members'.
CREATE INDEX IF NOT EXISTS idx_attendance_logs_member
  ON attendance_logs (member_id, date DESC)
  WHERE member_id IS NOT NULL;

-- ── 3. Row Level Security — already handled, deliberately not repeated ──────
--
-- This section adds nothing, and the reason is worth recording because the
-- first draft of this migration got it wrong.
--
-- Searching the migration files for `attendance_logs` alongside a policy finds
-- nothing, which reads as a table that never received RLS — it was created by
-- 001_v4_upgrade.sql, long before the convention that starts at 104.
--
-- That reading is false, twice over. TWO migrations already cover this table,
-- and neither one names it:
--
--   131_close_rls_gaps.sql builds its table list at run time and applies the
--   full house pattern — ENABLE ROW LEVEL SECURITY, REVOKE from anon and
--   authenticated, and a deny_all_direct_access policy.
--
--   157_app_tenant_role_and_rls.sql adds `tenant_isolation` to every table
--   that HAS an organization_id, discovered from information_schema. 087 gave
--   attendance_logs that column, so 157 has covered it since it shipped.
--
-- Verified on a real database rather than by reading: relrowsecurity is true
-- and the table carries deny_all_direct_access, tenant_isolation and
-- platform_select.
--
-- This is the same blind spot the audit documents for organization_id itself:
-- a dynamic `DO $$ … EXECUTE format()` migration is invisible to a text search,
-- so grep reports a gap where there is coverage. It cost that audit a wrong
-- count of 90 tables against a true 77, and it nearly cost this migration a
-- policy it had no business adding.
--
-- Adding a deny-all here would have been actively harmful rather than merely
-- redundant. Permissive policies are OR'd: a `USING (false)` policy alongside
-- `tenant_isolation` restricts nothing at all, while its presence tells the
-- next reader the table is deny-all when it is in fact tenant-scoped for
-- app_tenant. A guard that cannot deny and does mislead is worse than no guard.

-- ── Report ──────────────────────────────────────────────────────────────────
--
-- No backfill. There is nothing to backfill: no member has ever been able to
-- check in, so there are no rows to reclassify. Retyping existing 'client' rows
-- as 'member' would be the opposite of correct — those are PT clients'
-- attendance and they remain PT clients' attendance. 166 gave every PT client a
-- member record; it did not make their PT session history into gym visits.
DO $report$
DECLARE existing BIGINT;
BEGIN
  SELECT count(*) INTO existing FROM attendance_logs;
  RAISE NOTICE '[169] attendance accepts members: ref_type += ''member'', and a (member_id, organization_id) FK that makes a cross-tenant check-in unrepresentable.';
  RAISE NOTICE '[169] % existing row(s) left exactly as they are — PT attendance is not gym attendance.', existing;
END $report$;
