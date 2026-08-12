-- ============================================================
-- 118_backfill_missing_pt_subscription_terms.sql
--
-- DATA REPAIR: clients who are fully enrolled in a PT package but
-- show "No subscription terms recorded yet" on the PT Subscription
-- History page (Total Terms: 0), even though they're Active with a
-- real start/end date.
--
-- Cause: the enrollment action (PATCH /clients/:id, called from
-- pt-os/clients/[id]/enroll) never wrote a row into
-- pt_client_subscriptions — only the separate /renew endpoint did.
-- So a client's very first term was invisible on their history page
-- until their first renewal; renewals themselves rendered fine.
-- Fixed in code (PATCH /clients/:id now logs the initial term the
-- first time a client crosses into "enrolled"); this backfills rows
-- already written under the bug.
--
-- SCOPE — same "enrolled" condition the application already uses
-- (POST /clients, PATCH /clients/:id, and migration 110): an end
-- date, a real duration, or a real charged amount. Only clients with
-- ZERO existing pt_client_subscriptions rows are touched, so anyone
-- who already renewed (and therefore already has term history) is
-- left untouched.
--
-- Idempotent: re-running matches nothing once repaired.
-- ============================================================

INSERT INTO pt_client_subscriptions
  (client_id, plan_name, start_date, end_date, duration_months,
   selling_price, amount_paid, balance_amount, trainer_name, status, source)
SELECT
  c.id, c.package_type, c.pt_start_date, c.pt_end_date, c.duration_months,
  COALESCE(c.final_amount, 0), COALESCE(c.paid_amount, 0), COALESCE(c.balance_amount, 0),
  c.trainer_name, 'active', 'enrollment'
FROM pt_clients c
WHERE c.deleted_at IS NULL
  AND (
        c.pt_end_date IS NOT NULL
     OR COALESCE(c.final_amount, 0) > 0
     OR COALESCE(c.duration_months, 0) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM pt_client_subscriptions s WHERE s.client_id = c.id
  );
