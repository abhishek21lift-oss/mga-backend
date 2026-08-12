-- Founder numbers are permanent. Make the schema say so.
--
-- A founder number is allocated as MAX(founder_number)+1 over founder_members
-- (src/lib/subscription.js, under a SHARE ROW EXCLUSIVE table lock so two
-- concurrent purchases cannot collide). That is correct as long as rows are
-- never removed — and the foreign key said ON DELETE CASCADE, so deleting an
-- organisation would take its founder record with it and hand #7 to the next
-- studio through the door.
--
-- No route hard-deletes an organisation today, so this has never happened.
-- That is not the same as it being prevented: a manual cleanup, a future
-- delete endpoint, or a botched migration would all silently reissue a number
-- that was sold as one of only twenty. The guarantee belongs in the schema,
-- not in the continued absence of a DELETE.
--
-- RESTRICT rather than SET NULL: organization_id is this table's primary key,
-- so it cannot be nulled, and a founder record with no studio attached would
-- be a number reserved for nobody. Blocking the delete is the honest outcome —
-- a studio that bought a lifetime founder slot is not a row to be swept up,
-- and anyone who genuinely needs to remove one has to decide what happens to
-- the number first.

ALTER TABLE founder_members
  DROP CONSTRAINT IF EXISTS founder_members_organization_id_fkey;

ALTER TABLE founder_members
  ADD CONSTRAINT founder_members_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT founder_members_organization_id_fkey ON founder_members IS
  'RESTRICT, not CASCADE: founder numbers are allocated as MAX+1 and must never be reused.';

-- The cap is 20 and the numbering starts at 1. Both were only ever enforced by
-- the code that does the allocating; a direct UPDATE could put #0 or #47 in
-- here and nothing would object. The comment on the column already claimed
-- 1..20 — this makes the claim true.
--
-- Read from FOUNDER_LIMIT at deploy time would be ideal, but a CHECK cannot
-- read the environment. 20 is the product promise ("one of only 20"), so it is
-- the right number to hard-code; raising the cap is a deliberate act that
-- should require a migration saying so.
ALTER TABLE founder_members
  DROP CONSTRAINT IF EXISTS founder_members_number_within_cap;

ALTER TABLE founder_members
  ADD CONSTRAINT founder_members_number_within_cap
  CHECK (founder_number >= 1 AND founder_number <= 20);

-- organizations.founder_number is a denormalised copy of the same value, kept
-- so the badge can be rendered without a join. Same bounds apply, but NULL is
-- valid here — most studios are not founders.
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_founder_number_within_cap;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_founder_number_within_cap
  CHECK (founder_number IS NULL OR (founder_number >= 1 AND founder_number <= 20));

-- founder_members already carries RLS from 100_subscription_tables_enable_rls.sql
-- (ENABLE + deny-all + REVOKE). Nothing here creates a table, so there is no
-- new surface to protect.
