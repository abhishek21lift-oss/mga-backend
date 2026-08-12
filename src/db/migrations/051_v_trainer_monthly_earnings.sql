-- 051_v_trainer_monthly_earnings.sql
-- Creates the view queried by GET /api/v1/reports/trainer-payouts.
-- Aggregates pt_payments by trainer + month so the payouts report
-- can show how much each trainer earned in a given month.

DROP VIEW IF EXISTS v_trainer_monthly_earnings;
CREATE VIEW v_trainer_monthly_earnings AS
SELECT
  t.id                                              AS trainer_id,
  t.name                                            AS trainer_name,
  DATE_TRUNC('month', p.date::date)::DATE           AS month,
  COALESCE(SUM(p.amount),        0)                 AS total_revenue,
  COALESCE(SUM(p.incentive_amt), 0)                 AS total_incentive,
  COUNT(DISTINCT p.client_id)                       AS client_count
FROM pt_trainers t
LEFT JOIN pt_payments p
  ON p.trainer_id = t.id
  AND p.deleted_at IS NULL
WHERE t.deleted_at IS NULL
GROUP BY t.id, t.name, DATE_TRUNC('month', p.date::date);
