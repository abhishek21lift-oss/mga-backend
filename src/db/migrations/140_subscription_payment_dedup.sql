-- 140_subscription_payment_dedup.sql
--
-- Studios were getting two invoices for one transaction. Every OTHER payment
-- path in this system (a member paying a studio via migration 112, a studio
-- paying the platform via self-checkout via migration 113) has a partial
-- unique index that turns a repeated reference/UTR into a clean 409 instead
-- of a second payment row. The one path that never got this treatment is the
-- super admin's manual "Record Payment" action
-- (POST /organizations/:id/subscription/activate → lib/subscription.js
-- activate()) — a double click, a page refresh that resubmits, or an
-- operator recording the same UTR twice all sailed straight through and
-- minted a second subscription_payments row plus a second
-- subscription_invoices row off the back of it. The UTR is meant to be
-- usable exactly once; nothing enforced that.
--
-- Scoped to the organization (not platform-wide): this is a studio's own
-- billing history, not a shared UTR pool, so it matches migration 112's
-- scoping rather than 113's.
--
-- Only 'paid' rows participate. A refunded payment's reference is void, so
-- reusing that same reference for a genuine new charge must not be blocked.
--
-- ── Existing duplicates ──────────────────────────────────────────────────────
-- The constraint below cannot be created over data that already violates it,
-- and this bug has almost certainly already produced live examples (that is
-- what prompted this migration). So: before creating the index, void every
-- duplicate — keep the earliest 'paid' row per (organization_id, reference)
-- as the real payment, and flip every later row sharing that reference to
-- 'refunded' (never deleted, so the audit trail shows what happened) along
-- with the invoice it produced.
--
-- What this migration deliberately does NOT touch: current_period_end.
-- activate() stacks renewals on top of whatever time remains, so a duplicate
-- activation minutes apart would have stacked an extra period onto the
-- studio's expiry — real extra access, not just a paperwork duplicate.
-- Correcting a customer's entitlement date is a judgement call (has the
-- studio had further payments since? are they mid-period right now?) that
-- belongs to a human looking at that specific account, not a blind UPDATE in
-- a migration. The NOTICE below names every affected studio so operators
-- know exactly where to look.
DO $$
DECLARE
  dup RECORD;
  keep_id UUID;
  voided_count INT;
BEGIN
  FOR dup IN
    SELECT organization_id, reference
      FROM subscription_payments
     WHERE reference IS NOT NULL AND status = 'paid'
     GROUP BY organization_id, reference
    HAVING count(*) > 1
  LOOP
    SELECT id INTO keep_id
      FROM subscription_payments
     WHERE organization_id = dup.organization_id
       AND reference = dup.reference
       AND status = 'paid'
     ORDER BY created_at ASC
     LIMIT 1;

    UPDATE subscription_payments
       SET status = 'refunded',
           refunded_at = now(),
           notes = trim(both ' ' from
             coalesce(notes, '') ||
             ' [auto-voided by migration 140: duplicate recording of the same reference — see payment ' || keep_id::text || ']')
     WHERE organization_id = dup.organization_id
       AND reference = dup.reference
       AND status = 'paid'
       AND id <> keep_id;
    GET DIAGNOSTICS voided_count = ROW_COUNT;

    UPDATE subscription_invoices
       SET status = 'refunded'
     WHERE payment_id IN (
       SELECT id FROM subscription_payments
        WHERE organization_id = dup.organization_id
          AND reference = dup.reference
          AND status = 'refunded'
          AND id <> keep_id
     );

    RAISE NOTICE 'subscription_payment_dedup: voided % duplicate payment(s) for org % / reference % — kept %. REVIEW this studio''s current_period_end, a duplicate activation may have stacked an extra period onto it.',
      voided_count, dup.organization_id, dup.reference, keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_payments_live_reference
  ON subscription_payments (organization_id, reference)
  WHERE reference IS NOT NULL AND status = 'paid';
