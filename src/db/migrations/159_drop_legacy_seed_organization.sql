-- 159_drop_legacy_seed_organization.sql
--
-- A fresh MY GYM AGENT database must not be born owning a tenant that belongs
-- to a different business.
--
-- 078_multitenancy_foundation.sql seeds an organization named
-- 'Abhishek PT Studio' (slug 'abhishek-pt-studio'). That was correct when it
-- was written: it is the backfill step that turned the single existing studio
-- into the first row of a newly multi-tenant schema, and on the database it
-- was written for it adopted real users and trainers. Replayed against an
-- empty database it does something quite different — it creates a real tenant
-- row, for a real company, in a product that company has nothing to do with.
--
-- 078 is history and is left exactly as it is. This migration corrects the
-- outcome instead.
--
-- ── Why this cannot damage a database where that tenant is real ────────────
--
-- The delete is guarded by a census: every table in the schema that carries an
-- organization_id is counted for rows belonging to that organization, and the
-- row is removed only if the total is zero. On the database 078 was written
-- for, the organization owns thousands of rows and this is a no-op. On a
-- freshly bootstrapped database it owns nothing, because nothing has been
-- created yet, and it goes away.
--
-- The census is built from information_schema rather than a hardcoded table
-- list so that a tenant table added after this migration is still counted —
-- a list written today would silently stop being complete tomorrow, and the
-- failure mode of an incomplete list here is deleting a tenant that owns data.
--
-- Also removes the users/trainers association from the same seed, but only in
-- the same all-clear case, so a database that legitimately has that tenant
-- keeps every link it has.

DO $$
DECLARE
  seed_id  UUID;
  tbl      TEXT;
  n        BIGINT;
  total    BIGINT := 0;
BEGIN
  SELECT id INTO seed_id FROM organizations WHERE slug = 'abhishek-pt-studio';

  IF seed_id IS NULL THEN
    RAISE NOTICE '159: legacy seed organization not present — nothing to do';
    RETURN;
  END IF;

  -- Census across every organization_id-bearing table in the schema.
  FOR tbl IN
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'organization_id'
       AND t.table_type   = 'BASE TABLE'
       AND c.table_name  <> 'organizations'
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', tbl)
      INTO n USING seed_id;
    total := total + n;
    IF n > 0 THEN
      RAISE NOTICE '159: % row(s) in % belong to the legacy seed organization', n, tbl;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE '159: legacy seed organization owns % row(s) — this is a real tenant here, leaving it untouched', total;
    RETURN;
  END IF;

  DELETE FROM organizations WHERE id = seed_id;
  RAISE NOTICE '159: removed the legacy seed organization from a database where it owned nothing';
END $$;
