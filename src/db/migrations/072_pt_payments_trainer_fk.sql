-- 072_pt_payments_trainer_fk.sql
--
-- pt_payments.trainer_id pointed at pt_trainers — a parallel trainer table
-- that has always been empty. Real trainers live in `trainers` (managed by
-- /trainers), and pt_clients.trainer_id already stores trainers(id) values.
-- Because of the wrong FK, any payment carrying a real trainer id either
-- violated the constraint or had its trainer silently NULLed by the route's
-- fallback — losing trainer attribution and incentives on every payment.
--
-- Repoint the FK at trainers(id), same pattern as 063/071.

ALTER TABLE pt_payments DROP CONSTRAINT IF EXISTS pt_payments_trainer_id_fkey;

ALTER TABLE pt_payments
  ADD CONSTRAINT pt_payments_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE SET NULL;
