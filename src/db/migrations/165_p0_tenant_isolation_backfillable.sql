-- 165_p0_tenant_isolation_backfillable.sql
--
-- Phase 0 (P0-A) of the GMS transformation. Tenant-scopes the five remaining
-- tenant-owned tables whose owning organization can be derived EXACTLY from an
-- existing foreign key. See TENANT_SECURITY_AUDIT.md for the full inventory —
-- this file deliberately covers only the derivable subset.
--
-- ── Why these five and not the other sixteen ────────────────────────────────
--
-- TENANT_SECURITY_AUDIT.md lists 21 tenant-owned tables missing organization_id.
-- Sixteen of them (plans, pt_plans, pt_packages, offers, campaigns, feedback,
-- integrations, automation_rules, class_templates, class_sessions, bookings,
-- qr_tokens, receipt_counter, session_balance, branches, system_settings) carry
-- NO foreign key that identifies an owner. There is nothing to derive from, and
-- guessing an owner for a row is worse than leaving it NULL: a wrong guess hands
-- one studio's data to another permanently and silently, which is the exact
-- failure this work exists to prevent.
--
-- Those sixteen are gated on a read-only production count first — the method
-- MEMBERS-TENANT-GAP.md established and which settled that question correctly.
-- They are not in this file because the answer is not knowable from the
-- repository.
--
-- The five below need no such gate. Each has a NOT NULL foreign key to a table
-- that already carries organization_id, so the backfill is a join, not a
-- judgement.
--
-- ── The derivations, and why each FK target is the one named ────────────────
--
--   pt_lifestyle_assessments.client_id  -> pt_clients   (FK declared in 056)
--   pt_nutrition_assessments.client_id  -> pt_clients   (FK declared in 057)
--   pt_commissions.client_id            -> pt_clients   (REPOINTED by 017; the
--                                                        original 011b FK named
--                                                        `clients`, which is the
--                                                        empty legacy table)
--   pt_payouts.trainer_id               -> trainers     (REPOINTED by 145; 019
--                                                        had pointed it at
--                                                        pt_trainers, which has
--                                                        never held a row)
--   leave_requests.trainer_id           -> trainers     (FK declared in schema.sql)
--
-- The two repointings matter. Backfilling pt_payouts from `pt_trainers` — the
-- table its constraint named for six migrations — would attribute nothing at
-- all, because that table is empty; the migration would appear to succeed and
-- leave every row org-less. Reading the constraint as it stands TODAY rather
-- than as first declared is the difference between a working backfill and a
-- silent no-op.
--
-- ── Shape, following 156 ────────────────────────────────────────────────────
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, nullable, with an index,
-- then a join backfill, then the single-organization fallback 156 and 088 both
-- use. That fallback is a no-op on any database with more than one studio (it
-- is guarded on `count(*) = 1`), so it exists to keep a fresh single-tenant
-- install correct without being able to mis-attribute anything on the live
-- platform, which has six.
--
-- NOT NULL is deliberately NOT set here. 155_organization_id_not_null.sql owns
-- that step and does it check-then-tighten, so a single orphaned row degrades to
-- a warning rather than taking the deploy down. Tightening belongs in a later
-- run of that file, once these columns are populated and verified — the same
-- two-step this repository already follows everywhere else.
--
-- Safe to apply while the app is running: every statement is additive, and the
-- routes that will filter on these columns ship in the same change.

-- ── pt_lifestyle_assessments ────────────────────────────────────────────────
-- Carries smoking status, alcohol intake, stress and sleep scores, coach notes.
ALTER TABLE pt_lifestyle_assessments
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_lifestyle_assessments_organization_id
  ON pt_lifestyle_assessments(organization_id);

UPDATE pt_lifestyle_assessments a
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = a.client_id
   AND a.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE pt_lifestyle_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ── pt_nutrition_assessments ────────────────────────────────────────────────
-- Carries food allergies, medical conditions, medical notes, supplements.
ALTER TABLE pt_nutrition_assessments
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_nutrition_assessments_organization_id
  ON pt_nutrition_assessments(organization_id);

UPDATE pt_nutrition_assessments a
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = a.client_id
   AND a.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

UPDATE pt_nutrition_assessments
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ── pt_commissions ──────────────────────────────────────────────────────────
-- Derived from the client rather than the trainer: both FKs now resolve to
-- org-carrying tables, and client_id is the one 017 repointed deliberately.
ALTER TABLE pt_commissions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_commissions_organization_id
  ON pt_commissions(organization_id);

UPDATE pt_commissions pc
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = pc.client_id
   AND pc.organization_id IS NULL
   AND c.organization_id IS NOT NULL;

-- Second pass via the trainer, for any row whose client has since been hard
-- deleted. Cannot conflict with the pass above: it only touches rows still NULL.
UPDATE pt_commissions pc
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = pc.trainer_id
   AND pc.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

UPDATE pt_commissions
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ── pt_payouts ──────────────────────────────────────────────────────────────
ALTER TABLE pt_payouts
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pt_payouts_organization_id
  ON pt_payouts(organization_id);

UPDATE pt_payouts pp
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = pp.trainer_id
   AND pp.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

UPDATE pt_payouts
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ── leave_requests ──────────────────────────────────────────────────────────
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests_organization_id
  ON leave_requests(organization_id);

UPDATE leave_requests lr
   SET organization_id = t.organization_id
  FROM trainers t
 WHERE t.id = lr.trainer_id
   AND lr.organization_id IS NULL
   AND t.organization_id IS NOT NULL;

UPDATE leave_requests
   SET organization_id = (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
 WHERE organization_id IS NULL
   AND (SELECT count(*) FROM organizations) = 1;

-- ── Report what could not be attributed ─────────────────────────────────────
--
-- A backfill that quietly leaves rows NULL is the failure mode this whole
-- exercise is about: the routes shipping alongside this migration filter on
-- organization_id, and NULL matches nothing, so an unattributed row becomes
-- invisible to the studio that owns it rather than leaking to one that does
-- not. That is the safe direction to fail, but it is still data the owner can
-- no longer see, so it must be said out loud rather than discovered later.
--
-- NOTICE, not EXCEPTION: migrate.js runs on every boot and aborts the whole run
-- on the first failure. Refusing to start the API because one historical row
-- has no derivable owner would turn a data-quality problem into an outage — the
-- same reasoning 155_organization_id_not_null.sql sets out for its own skips.
DO $report$
DECLARE
  t          text;
  orphans    bigint;
  total_orph bigint := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pt_lifestyle_assessments', 'pt_nutrition_assessments',
    'pt_commissions', 'pt_payouts', 'leave_requests'
  ]
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE organization_id IS NULL', t) INTO orphans;
    total_orph := total_orph + orphans;
    IF orphans > 0 THEN
      RAISE NOTICE '[165] % — % row(s) could not be attributed to an organization. They are now invisible to every tenant (fail-closed). Attribute them by hand before 155 can tighten this column to NOT NULL.', t, orphans;
    END IF;
  END LOOP;

  IF total_orph = 0 THEN
    RAISE NOTICE '[165] All five tables fully attributed. 155_organization_id_not_null.sql can tighten these columns on its next run.';
  END IF;
END $report$;
