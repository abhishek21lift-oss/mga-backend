-- ============================================================
-- 145_pt_trainer_fks_point_at_trainers.sql
--
-- Booking a PT session has never once worked. `pt_sessions` is empty — not
-- "empty since a recent regression", empty for the whole life of the table —
-- and so are `pt_commissions` and `pt_payouts`. All three fail for the same
-- reason.
--
-- Their trainer_id foreign keys reference `pt_trainers`. `pt_trainers` has
-- never had a row in it. Every trainer on the platform lives in `trainers`:
--
--   trainers      6 rows
--   pt_trainers   0 rows
--
-- A foreign key pointing at an empty table can only ever be satisfied by
-- NULL. POST /api/pt-os/sessions always sends a real trainer_id — the Book
-- PT Session dialog fills it in from the studio's own trainer and there is no
-- way to clear it — so every INSERT hits
-- pt_sessions_trainer_id_fkey and is rejected. The trainer the dialog offers
-- is read via GET /api/pt-os/trainers, which UNIONs `trainers` with
-- `pt_trainers`, so the id it hands back is a `trainers` id that the INSERT
-- then cannot use.
--
-- `trainers` is the canonical table and the rest of the schema already knows
-- it. Of the 27 trainer_id foreign keys in this database, 24 reference
-- `trainers` — including pt_payments, pt_assessments, pt_os_sessions,
-- pt_os_earnings and pt_os_assignments. Only these three reference
-- `pt_trainers`. POST /api/pt-os/trainers says so out loud in its own comment:
-- "Insert into the canonical trainers table (not pt_trainers)". These three
-- are the outliers, not the convention.
--
-- So: repoint them. Nothing is migrated because there is nothing to migrate —
-- all three tables are empty precisely because the constraint made writing to
-- them impossible.
--
-- ── On the two NOT NULL ones ────────────────────────────────────────────
--
-- pt_sessions.trainer_id is nullable, so any orphan in a non-production
-- database can be nulled out before the new constraint is validated.
--
-- pt_commissions.trainer_id and pt_payouts.trainer_id are NOT NULL, so an
-- orphan there cannot be nulled and deleting rows to satisfy a migration is
-- not something this should do quietly. Those two get their constraint added
-- NOT VALID and validated separately: new writes are checked from this moment
-- on, pre-existing rows are left alone, and if validation cannot pass the
-- migration says which table and moves on rather than wedging startup — this
-- file runs on every boot via src/db/migrate.js.
--
-- ON DELETE behaviour is carried over unchanged from the constraints being
-- replaced (SET NULL for sessions, CASCADE for the two money tables). Whether
-- CASCADE is right for payout history is a real question, but it is a separate
-- one from "this table cannot be written to at all".
-- ============================================================

-- ── pt_sessions ─────────────────────────────────────────────────────────
-- Nullable, so orphans can be released rather than deleted.
UPDATE pt_sessions s
   SET trainer_id = NULL
 WHERE s.trainer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM trainers t WHERE t.id = s.trainer_id);

ALTER TABLE pt_sessions DROP CONSTRAINT IF EXISTS pt_sessions_trainer_id_fkey;

ALTER TABLE pt_sessions
  ADD CONSTRAINT pt_sessions_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE SET NULL;

-- ── pt_commissions / pt_payouts ─────────────────────────────────────────
-- NOT NULL, so the constraint goes on NOT VALID and is validated below.
ALTER TABLE pt_commissions DROP CONSTRAINT IF EXISTS pt_commissions_trainer_id_fkey;

ALTER TABLE pt_commissions
  ADD CONSTRAINT pt_commissions_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE CASCADE
  NOT VALID;

ALTER TABLE pt_payouts DROP CONSTRAINT IF EXISTS pt_payouts_trainer_id_fkey;

ALTER TABLE pt_payouts
  ADD CONSTRAINT pt_payouts_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE CASCADE
  NOT VALID;

-- Validate what can be validated. In production both tables are empty, so both
-- pass immediately and end up fully validated. Anywhere with orphaned rows,
-- the NOT VALID constraint still governs every new write and the leftover rows
-- are named rather than silently dropped.
DO $$
BEGIN
  BEGIN
    ALTER TABLE pt_commissions VALIDATE CONSTRAINT pt_commissions_trainer_id_fkey;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'pt_commissions has rows whose trainer_id is not in trainers; the FK is enforced for new writes but those rows need a human. %', SQLERRM;
  END;

  BEGIN
    ALTER TABLE pt_payouts VALIDATE CONSTRAINT pt_payouts_trainer_id_fkey;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'pt_payouts has rows whose trainer_id is not in trainers; the FK is enforced for new writes but those rows need a human. %', SQLERRM;
  END;
END $$;
