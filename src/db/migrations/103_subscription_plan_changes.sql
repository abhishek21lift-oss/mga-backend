-- 103_subscription_plan_changes.sql
-- Phase 2 of the SaaS billing work: upgrade / downgrade with proration.
--
-- Two different behaviours, per the product spec:
--   • UPGRADE   — takes effect immediately. The unused value of the current
--                 period is credited against the new plan's price, so the studio
--                 pays only the difference. Handled entirely by
--                 subscription.changePlan(), which writes a payment + invoice
--                 exactly like activate() does. No schema support needed.
--   • DOWNGRADE — takes effect at the END of the current billing cycle, so the
--                 studio keeps what it paid for. That requires remembering the
--                 pending plan until the period rolls over, which is what the
--                 columns below are for.
--
-- A downgrade is stored, not applied. subscription.worker.js applies it once
-- current_period_end passes. Storing it on organizations (rather than a separate
-- schedule table) keeps it in the same row the access check already reads, and
-- there can only ever be one pending change per studio — requesting another
-- simply overwrites it.
--
-- Idempotent: safe to re-run.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_plan_code TEXT REFERENCES subscription_plans(code);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_plan_effective_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pending_plan_requested_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.pending_plan_code IS
  'Scheduled downgrade target. Applied by the subscription worker at pending_plan_effective_at; NULL when no change is scheduled.';
COMMENT ON COLUMN organizations.pending_plan_effective_at IS
  'When the scheduled downgrade takes effect — normally the current period end.';

-- Only one pending change matters at a time, and lookups are "which studios have
-- a downgrade now due", so a partial index over the scheduled rows is enough.
CREATE INDEX IF NOT EXISTS idx_organizations_pending_plan_due
  ON organizations (pending_plan_effective_at)
  WHERE pending_plan_code IS NOT NULL;

-- Proration credit is recorded on the payment row so an invoice can show what
-- was actually charged versus what the plan lists. NULL for ordinary
-- activations and renewals, which carry no credit.
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS proration_credit_inr INTEGER;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS previous_plan_code TEXT REFERENCES subscription_plans(code);

COMMENT ON COLUMN subscription_payments.proration_credit_inr IS
  'Unused value of the previous period credited against this charge (upgrades only).';
