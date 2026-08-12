-- How the client paid, and the agreement they signed to enrol.
--
-- payment_method lives on pt_clients rather than on pt_payments because
-- enrolment does not create a payment row — it writes final_amount and
-- paid_amount onto the client and nothing else. pt_payments.payment_method
-- already exists and is the right home for a RENEWAL's method; this column is
-- the method for the enrolling transaction, which has no row of its own.
--
-- The agreement columns store what the client actually agreed to, not just
-- that they agreed. agreement_text is a copy of the wording shown at the time,
-- because the wording will change and "they ticked a box" is worthless
-- evidence if nobody can say which box.
--
-- No new table, so no RLS block: pt_clients already carries its own.

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS payment_method        TEXT,
  ADD COLUMN IF NOT EXISTS agreement_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agreement_signature   TEXT,
  ADD COLUMN IF NOT EXISTS agreement_text        TEXT;

COMMENT ON COLUMN pt_clients.payment_method IS
  'How the enrolling payment was taken: CASH | UPI | CARD | BANK_TRANSFER | SPLIT.';
COMMENT ON COLUMN pt_clients.agreement_text IS
  'The exact agreement wording shown when it was signed. Kept because the wording changes and a bare acceptance flag cannot say which version was agreed to.';
