-- 102_plan_limits_and_founder_cap.sql
-- Phase 1 of the SaaS billing alignment: bring the plan matrix in line with the
-- product spec.
--
--   Plan          Price      Duration   Client limit
--   Starter       ₹1,499     1 month     20 → 5
--   Growth        ₹3,999     3 months    25 → 15
--   Professional  ₹6,999     6 months    30    (unchanged)
--   Elite         ₹9,999     12 months   NULL  (unlimited, unchanged)
--
-- Prices and durations are already correct and are deliberately left alone. The
-- Founder's Club cap moves 50 → 20, which lives in lib/subscription.js
-- (FOUNDER_LIMIT); this migration only refreshes the stale column comments that
-- referenced 50, and re-syncs any organization already pinned to a plan.
--
-- Safety: at the time of writing every organization is grandfathered
-- (plan_code IS NULL, client_limit IS NULL = unlimited) and no founder slots
-- have been granted, so the UPDATE below matches zero rows. It is included so
-- the migration stays correct if applied to an environment that does have
-- studios on paid plans — their limit must follow the plan they bought.
--
-- Idempotent: safe to re-run.

UPDATE subscription_plans SET client_limit = 5,  updated_at = now() WHERE code = 'starter';
UPDATE subscription_plans SET client_limit = 15, updated_at = now() WHERE code = 'growth';
UPDATE subscription_plans SET client_limit = 30, updated_at = now() WHERE code = 'professional';
UPDATE subscription_plans SET client_limit = NULL, updated_at = now() WHERE code = 'elite';

-- Re-sync studios that are on a plan so their enforced limit matches the plan
-- they actually purchased. Grandfathered studios (plan_code IS NULL) keep their
-- unlimited NULL limit and are untouched.
UPDATE organizations o
   SET client_limit = p.client_limit,
       updated_at = now()
  FROM subscription_plans p
 WHERE o.plan_code = p.code
   AND o.client_limit IS DISTINCT FROM p.client_limit;

-- Founder's Club is capped at 20 (was 50).
COMMENT ON COLUMN organizations.founder_number IS '1..20 once granted (Founder''s Club cap)';
COMMENT ON COLUMN founder_members.founder_number IS '1..20 (Founder''s Club cap)';
