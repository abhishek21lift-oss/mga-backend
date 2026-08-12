-- Migration 019b: Remove PT payment duplicates created by migration 018
-- Migration 018 copied PT payments to pt_payments but did not remove them from payments.
-- This removes the duplicate rows from payments where they already exist in pt_payments.

DELETE FROM payments p
WHERE EXISTS (
  SELECT 1 FROM pt_payments pp
  WHERE pp.amount = p.amount
    AND pp.client_id = p.client_id
    AND pp.date = p.date
    AND pp.payment_method = p.method
);
