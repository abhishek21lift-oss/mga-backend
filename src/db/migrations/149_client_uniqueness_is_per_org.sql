-- 149_client_uniqueness_is_per_org.sql
--
-- Client mobile/email uniqueness on pt_clients was PLATFORM-WIDE, not per studio.
--
--   CREATE UNIQUE INDEX pt_clients_mobile_unique ON pt_clients (mobile);
--
-- No organization_id. So one studio adding a client permanently burned that
-- phone number for every other studio on the platform. Observed in production:
--
--   04:41  "Stuti Yadav"  6387171298  created in Abhishek PT Studio
--   04:51  ADVENTURE PT STUDIO signs in, tries to add the same person
--          -> 23505, "Duplicate entry — this record already exists."
--   04:58  same studio retries with a different number -> succeeds
--
-- From inside ADVENTURE PT STUDIO the client list was empty, so "this record
-- already exists" was not just unhelpful, it was untrue as far as that user
-- could see. It reads as a broken button.
--
-- Not an edge case: a person training at two studios, a shared family number, a
-- couple on one mobile, or a reused onboarding number all hit it. It is also a
-- cross-tenant information leak — the error let any studio probe whether a
-- phone number or email exists ANYWHERE on the platform, which is a fact about
-- someone else's client list.
--
-- ── Why this does NOT weaken tenant isolation ────────────────────────────────
--
-- Isolation here is enforced by tenantScope() in application SQL (every read
-- and write ANDs organization_id), plus deny-all RLS that makes the anon and
-- authenticated keys inert. A unique index governs what may be WRITTEN, never
-- who may READ. Dropping a global constraint cannot widen anyone's visibility.
-- The global index was itself the leak; removing it narrows the surface.
--
-- Verified before writing this: no code path looks a client up by mobile or
-- email and assumes a single global row. Every by-email lookup in the codebase
-- targets `users`, whose global uniqueness is untouched below.
--
-- ── Scope: pt_clients only ───────────────────────────────────────────────────
--
-- An earlier draft also rewrote clients_mobile_uniq / clients_email_uniq on the
-- legacy `clients` table. That was wrong and would have aborted the migration:
-- `clients` has NO organization_id column, so the CREATE INDEX referenced a
-- column that does not exist. It slipped through local validation because the
-- throwaway test schema was hand-written WITH an organization_id rather than
-- mirrored from production — the check confirmed the SQL against a table that
-- does not exist anywhere real.
--
-- The migration runner wraps each file in BEGIN/COMMIT and rolls back on error,
-- so the failure would have been clean rather than destructive. It would simply
-- not have fixed anything.
--
-- `clients` is left exactly as it is: it holds 0 rows, it is the superseded
-- roster (the product writes pt_clients), and without an organization_id column
-- its uniqueness cannot be scoped anyway. Making it per-org is part of giving
-- that table a tenant boundary at all — a separate change, and only worth doing
-- if the table is ever revived. See BACKEND-FRONTEND-AUDIT.md §4.0.
--
-- ── Two incidental corrections to the pt_clients indexes ─────────────────────
--
--   * pt_clients_mobile_unique had no WHERE clause, so two clients with an
--     empty-string mobile collided ('' is not NULL). Now excluded.
--   * pt_clients_email_unique compared email verbatim, so Ravi@x.com and
--     ravi@x.com were different addresses. Now lower().
--
-- Safe on existing data: the indexes being dropped were STRICTLY stronger than
-- the ones replacing them, so anything that satisfied the global constraint
-- satisfies the per-org one. No duplicates can be waiting.
--
-- NOT touched: users_email_key and trainers_email_uniq. A user's email is their
-- login identity and must stay globally unique; trainers resolve to users, so
-- the same reasoning applies. Only client records are per-studio data.

-- The two old objects are NOT the same kind of thing, and dropping them takes
-- two different statements.
--
--   pt_clients_mobile_unique  is a UNIQUE CONSTRAINT — `UNIQUE (mobile)`.
--   pt_clients_email_unique   is a plain partial index, `WHERE email IS NOT
--                             NULL`, which a constraint cannot express.
--
-- DROP INDEX cannot remove a constraint-backed index; Postgres refuses with
-- "cannot drop index … because constraint … requires it". The first attempt to
-- apply this migration failed on exactly that, because the local rehearsal had
-- created mobile as a plain index rather than mirroring production's
-- constraint. Both forms are handled below so this works against either shape:
-- ALTER TABLE removes the constraint and its index together, and the following
-- DROP INDEX is a no-op there but the real drop on a database where the object
-- was only ever an index.
ALTER TABLE pt_clients DROP CONSTRAINT IF EXISTS pt_clients_mobile_unique;
DROP INDEX IF EXISTS pt_clients_mobile_unique;

ALTER TABLE pt_clients DROP CONSTRAINT IF EXISTS pt_clients_email_unique;
DROP INDEX IF EXISTS pt_clients_email_unique;

CREATE UNIQUE INDEX IF NOT EXISTS pt_clients_org_mobile_unique
  ON pt_clients (organization_id, mobile)
  WHERE mobile IS NOT NULL AND mobile <> '';

CREATE UNIQUE INDEX IF NOT EXISTS pt_clients_org_email_unique
  ON pt_clients (organization_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';
