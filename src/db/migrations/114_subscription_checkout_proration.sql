-- ============================================================
-- 114_subscription_checkout_proration.sql
--
-- Closes a gap in 113: self-checkout only ever priced a BRAND NEW
-- subscription (subscription.effectivePrice() against the plan's list price).
-- An already-active studio switching or renewing a plan was never routed
-- through checkout at all — the tenant page sent that case down the older
-- request-change path instead, which has no payment collection, no UTR,
-- nothing for the operator to verify. It just logs an event and trusts the
-- studio was telling the truth.
--
-- So checkout needs to carry the same proration bookkeeping
-- subscription.changePlan() already computes for that path: what the studio
-- is being credited for unused time on their current plan, and what plan
-- they're moving FROM. Approval passes these straight to
-- subscription.activate() (resetPeriod + prorationCreditInr +
-- previousPlanCode) so an upgrade/renewal charged through checkout produces
-- exactly the same payment/invoice shape as one executed by an operator.
-- ============================================================

ALTER TABLE subscription_payment_requests
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'activation'
    CHECK (direction IN ('activation', 'renewal', 'upgrade')),
  ADD COLUMN IF NOT EXISTS proration_credit_inr INTEGER NOT NULL DEFAULT 0
    CHECK (proration_credit_inr >= 0),
  ADD COLUMN IF NOT EXISTS previous_plan_code TEXT
    REFERENCES subscription_plans(code) ON DELETE SET NULL;

-- Existing rows (all from before this migration, so all genuine first
-- activations) are correctly backfilled by the column defaults above —
-- direction='activation', credit=0, previous plan=NULL — with no UPDATE
-- needed.
