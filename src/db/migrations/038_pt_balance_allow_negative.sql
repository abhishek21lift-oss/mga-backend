-- ============================================================
-- 038_pt_balance_allow_negative.sql
-- ISSUE-019: Remove the CHECK (balance_amount >= 0) constraint
-- from pt_clients so that refunds can result in a negative
-- balance_amount, which represents a credit owed to the client.
--
-- A negative balance_amount means the gym owes the client money
-- (e.g. the client overpaid or was issued a refund that exceeds
-- what they owe).  Business logic and the UI layer are responsible
-- for displaying this as a credit rather than a debt.
-- ============================================================

ALTER TABLE pt_clients
  DROP CONSTRAINT IF EXISTS pt_clients_balance_amount_check;
