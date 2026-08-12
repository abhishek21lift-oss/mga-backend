-- ============================================================
-- 143_pt_trainers_organization_id.sql
--
-- GET /api/pt-os/trainers returned every trainer on the platform to every
-- studio. The Book PT Session dialog showed four trainers from four different
-- studios side by side, and the payload carried more than the names: email,
-- mobile, specialization and incentive_rate — one studio's commission terms,
-- readable by its competitors.
--
-- The route simply had no tenant filter. Every sibling in the same file scopes
-- with tenantScope(req); this one queried `trainers` and `pt_trainers` raw.
--
-- `trainers` has carried organization_id since migration 078. `pt_trainers`
-- never got one, so the route could not have filtered on it even if it tried.
-- This adds it.
--
-- ── Backfilling ─────────────────────────────────────────────────────────
--
-- Two passes, most reliable first, because a row left NULL disappears from
-- its studio once the route starts filtering. Getting this wrong makes real
-- trainers vanish, which is worse for a studio than the leak it fixes.
--
--   1. By id. Migration 018 seeded pt_trainers from trainers with
--      `INSERT ... SELECT id, ...`, preserving the primary key, so the same
--      id in both tables is the same person.
--
--   2. By the clients they train. A trainer with pt_clients rows in exactly
--      one organization belongs to that organization. Restricted to exactly
--      one so a trainer somehow linked to two studios is left for a human
--      rather than assigned by coin flip.
--
-- Anything still NULL is reported by count. Those rows are unattributable —
-- and showing an unattributable trainer to every studio is precisely the bug,
-- so they stay hidden until someone assigns them.
-- ============================================================

ALTER TABLE pt_trainers
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pt_trainers_organization_id
  ON pt_trainers(organization_id);

-- Pass 1: the shared primary key from migration 018's seed.
UPDATE pt_trainers pt
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = pt.id
   AND pt.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

-- Pass 2: the studio whose clients they train, when that is unambiguous.
UPDATE pt_trainers pt
   SET organization_id = sole.organization_id
  FROM (
    -- array_agg, not MIN: Postgres has no min() for uuid. HAVING below
    -- guarantees exactly one distinct value, so the first element IS the answer.
    SELECT trainer_id, (array_agg(DISTINCT organization_id))[1] AS organization_id
      FROM pt_clients
     WHERE trainer_id IS NOT NULL
       AND organization_id IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY trainer_id
    HAVING COUNT(DISTINCT organization_id) = 1
  ) sole
 WHERE sole.trainer_id = pt.id
   AND pt.organization_id IS NULL;

-- Same two passes for `trainers` itself: it has had the column since 078, but
-- POST /api/pt-os/trainers never populated it, so every trainer created
-- through the PT-OS screen is org-less and would vanish under the new filter.
UPDATE trainers t
   SET organization_id = sole.organization_id
  FROM (
    -- array_agg, not MIN: Postgres has no min() for uuid. HAVING below
    -- guarantees exactly one distinct value, so the first element IS the answer.
    SELECT trainer_id, (array_agg(DISTINCT organization_id))[1] AS organization_id
      FROM pt_clients
     WHERE trainer_id IS NOT NULL
       AND organization_id IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY trainer_id
    HAVING COUNT(DISTINCT organization_id) = 1
  ) sole
 WHERE sole.trainer_id = t.id
   AND t.organization_id IS NULL
   AND t.deleted_at IS NULL;

-- Report what could not be attributed, so it is a known number rather than a
-- silent disappearance someone notices weeks later.
DO $$
DECLARE
  orphan_pt  INT;
  orphan_tr  INT;
BEGIN
  SELECT count(*) INTO orphan_pt FROM pt_trainers
   WHERE organization_id IS NULL AND deleted_at IS NULL AND status = 'active';
  SELECT count(*) INTO orphan_tr FROM trainers
   WHERE organization_id IS NULL AND deleted_at IS NULL AND status = 'active';

  IF orphan_pt > 0 OR orphan_tr > 0 THEN
    RAISE NOTICE 'pt_trainers: % active row(s) and trainers: % active row(s) still have no organization_id. They are now hidden from every studio rather than shown to all of them — assign them to a studio to restore them.',
      orphan_pt, orphan_tr;
  END IF;
END $$;
