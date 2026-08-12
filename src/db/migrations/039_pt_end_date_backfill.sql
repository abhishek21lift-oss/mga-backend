-- ============================================================
-- 039_pt_end_date_backfill.sql
-- ISSUE-020: Backfill NULL pt_end_date values so every
-- pt_clients row has an end date.  After this migration the
-- application-level Zod schema requires pt_end_date on new
-- client creation (see pt-os.routes.js ptClientCreateSchema).
-- ============================================================

-- 1. Use pt_start_date + 1 month where a start date is known.
UPDATE pt_clients
SET pt_end_date = pt_start_date::date + INTERVAL '1 month'
WHERE pt_end_date IS NULL AND pt_start_date IS NOT NULL;

-- 2. Fall back to created_at + 1 month for rows with no start date.
UPDATE pt_clients
SET pt_end_date = created_at::date + INTERVAL '1 month'
WHERE pt_end_date IS NULL;
