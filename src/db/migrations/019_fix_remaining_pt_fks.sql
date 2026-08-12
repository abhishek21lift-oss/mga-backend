-- ============================================================
-- 019_fix_remaining_pt_fks.sql
-- Final FK cleanup: pt_commissions & pt_payouts still reference
-- shared trainers/clients tables instead of pt_* equivalents.
-- ============================================================

DO $$ BEGIN
  -- pt_commissions.trainer_id → pt_trainers
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_commissions_trainer_id_fkey') THEN
    ALTER TABLE pt_commissions DROP CONSTRAINT pt_commissions_trainer_id_fkey;
  END IF;
  ALTER TABLE pt_commissions ADD CONSTRAINT pt_commissions_trainer_id_fkey
    FOREIGN KEY (trainer_id) REFERENCES pt_trainers(id) ON DELETE CASCADE;

  -- pt_payouts.trainer_id → pt_trainers
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pt_payouts_trainer_id_fkey') THEN
    ALTER TABLE pt_payouts DROP CONSTRAINT pt_payouts_trainer_id_fkey;
  END IF;
  ALTER TABLE pt_payouts ADD CONSTRAINT pt_payouts_trainer_id_fkey
    FOREIGN KEY (trainer_id) REFERENCES pt_trainers(id) ON DELETE CASCADE;
END $$;
