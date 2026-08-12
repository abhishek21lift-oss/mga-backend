-- 098_pt_clients_pending_status.sql
-- A PT client is only genuinely "active" once they have enrolled in a package
-- (a priced/duration-bound program with an end date). Until then they are a
-- lead that has merely been added to the roster. Previously every newly-added
-- client was stamped status='active' at creation, so name-only entries with no
-- package, ₹0 amount and no pt_end_date showed up in the "Active clients" list
-- and counts. This backfills those not-yet-enrolled clients to a new 'pending'
-- status so they stop counting as active. Enrolling/renewing them (which sets
-- package + duration + end date) promotes them back to 'active'.
--
-- Signal for "not enrolled": no end date AND no charged amount AND no duration.
-- Idempotent — safe to re-run. There is no CHECK constraint on status, so the
-- new 'pending' value needs no schema change.

UPDATE pt_clients
   SET status = 'pending', updated_at = NOW()
 WHERE deleted_at IS NULL
   AND status = 'active'
   AND pt_end_date IS NULL
   AND COALESCE(final_amount, 0) = 0
   AND COALESCE(duration_months, 0) = 0;
