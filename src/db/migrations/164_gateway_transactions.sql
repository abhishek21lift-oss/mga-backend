-- ============================================================
-- 164_gateway_transactions.sql
--
-- The canonical record of a payment-provider transaction.
--
-- ── Why a new table ──────────────────────────────────────────────────
--
-- Not because code referenced one. Because none of the seven existing
-- finance tables can represent this domain without being bent:
--
--   payments              the pre-tenancy ledger from foundation/schema-v4.
--                         It is the ONLY finance table with no
--                         organization_id and no policy — every table
--                         created after the tenancy model has both — and
--                         migration 018_complete_pt_independence.sql
--                         already moved PT money out of it. Backfilling a
--                         tenant onto its historical rows would be
--                         guesswork on financial records, because its
--                         client_id points at pt_clients, which is exactly
--                         what 018 split away.
--
--   payment_orders        UPI-shaped: upi_id, merchant_name, order_no. It
--                         models an intent to pay, not money moving, and
--                         has no provider, event or capture concept.
--
--   payment_submissions   a member's uploaded proof for manual approval.
--
--   pt_payments,          settled money, per business domain, recorded
--   membership_payments,  after the fact. A provider transaction is a
--   subscription_payments different thing: it has a lifecycle
--                         (created → captured → failed → refunded) driven
--                         by an external system, and it must be reconciled
--                         against whichever of those a payment settles.
--
-- None of them has anywhere to put a provider event id, which is what
-- webhook idempotency requires. Adding provider columns to any one of them
-- would make that table mean two things at once.
--
-- ── Tenancy ──────────────────────────────────────────────────────────
--
-- organization_id is stored directly rather than derived through
-- payment_order_id. RLS needs a predicate it can evaluate on the row
-- itself; a policy that joined to reach the tenant would be both slower
-- and easier to get wrong, and payment_order_id is nullable because a
-- gateway charge does not always originate from a UPI order.
--
-- ── Why the webhook cannot write this table directly ─────────────────
--
-- A Razorpay callback is unauthenticated by nature: the provider has no
-- session and no organisation. app.org_id is therefore never set on that
-- path, so a strict policy — which this table has — refuses the write.
--
-- That is the same shape as public studio registration, and it gets the
-- same answer: one narrow SECURITY DEFINER function that crosses the
-- boundary for exactly this operation, rather than a policy hole. See
-- 162_public_registration_function.sql for the reasoning in full.
--
-- Idempotent, and safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.gateway_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Provider-agnostic from the start: Razorpay is the only one wired today,
  -- but the column costs nothing now and a second provider would otherwise
  -- mean either a second table or a rename.
  provider            text NOT NULL DEFAULT 'razorpay',
  provider_payment_id text NOT NULL,
  provider_order_id   text,

  -- The event that last moved this row. Razorpay sends an id per delivery,
  -- so this is what makes a redelivery a no-op rather than a second write.
  last_event_id       text,

  status              text NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','captured','failed','refunded')),
  amount              numeric(12,2),
  currency            text NOT NULL DEFAULT 'INR',
  refund_id           text,

  -- The provider's own entity, kept verbatim for reconciliation. Never
  -- parsed for authorisation — the row's organization_id is the tenant,
  -- not anything inside this document.
  payload             jsonb,

  -- Nullable: a gateway charge does not always begin as a UPI order.
  payment_order_id    uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per provider payment. This is what lets the webhook upsert by
-- provider id without ever reading a tenant from the message.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_transactions_provider_payment_uniq
  ON public.gateway_transactions (provider, provider_payment_id);

CREATE INDEX IF NOT EXISTS gateway_transactions_org_created_idx
  ON public.gateway_transactions (organization_id, created_at DESC);

-- ── RLS: strict, same shape as every other tenant table from 157 ─────
ALTER TABLE public.gateway_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_transactions FROM anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='gateway_transactions'
       AND policyname='deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON public.gateway_transactions
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN
    DROP POLICY IF EXISTS tenant_isolation ON public.gateway_transactions;
    CREATE POLICY tenant_isolation ON public.gateway_transactions
      FOR ALL TO app_tenant
      USING (organization_id::text = current_setting('app.org_id', true))
      WITH CHECK (organization_id::text = current_setting('app.org_id', true));
    GRANT SELECT, INSERT, UPDATE ON public.gateway_transactions TO app_tenant;
  END IF;

  -- The Command Centre reconciles across studios, so the platform role
  -- reads it. No DELETE for either role: a financial record is corrected
  -- by a later row, not removed.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_platform') THEN
    DROP POLICY IF EXISTS platform_select ON public.gateway_transactions;
    CREATE POLICY platform_select ON public.gateway_transactions
      FOR SELECT TO app_platform USING (true);
    GRANT SELECT ON public.gateway_transactions TO app_platform;
  END IF;
END $$;

-- ── The one write path a provider callback may use ───────────────────
--
-- Takes the provider's identifiers and nothing else. The tenant is read
-- from the row this function finds, never from the caller: there is no
-- organization_id parameter, so a forged one has nowhere to go.
--
-- Idempotent by construction. A redelivery of the same event id changes
-- nothing and reports applied = false, so a duplicate cannot double-count
-- revenue or re-trigger downstream work.
CREATE OR REPLACE FUNCTION public.gateway_record_event(
  p_provider           text,
  p_provider_payment_id text,
  p_event_id           text,
  p_status             text,
  p_payload            jsonb,
  p_refund_id          text DEFAULT NULL
)
RETURNS TABLE (transaction_id uuid, organization_id uuid, applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.gateway_transactions%ROWTYPE;
BEGIN
  IF p_status NOT IN ('captured','failed','refunded') THEN
    RAISE EXCEPTION 'unsupported gateway status %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Locked, so two concurrent deliveries of the same event cannot both
  -- decide they are the first.
  SELECT * INTO v_row FROM public.gateway_transactions
   WHERE provider = p_provider AND provider_payment_id = p_provider_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- No such transaction. The caller is told so plainly; inventing a row
    -- would mean inventing a tenant for it.
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, false;
    RETURN;
  END IF;

  IF p_event_id IS NOT NULL AND v_row.last_event_id = p_event_id THEN
    RETURN QUERY SELECT v_row.id, v_row.organization_id, false;   -- already applied
    RETURN;
  END IF;

  UPDATE public.gateway_transactions
     SET status        = p_status,
         payload       = COALESCE(p_payload, payload),
         refund_id     = COALESCE(p_refund_id, refund_id),
         last_event_id = COALESCE(p_event_id, last_event_id),
         updated_at    = now()
   WHERE id = v_row.id;

  RETURN QUERY SELECT v_row.id, v_row.organization_id, true;
END;
$fn$;

COMMENT ON FUNCTION public.gateway_record_event(text, text, text, text, jsonb, text) IS
  'Idempotent provider-callback write path for gateway_transactions. Resolves '
  'the tenant from the stored row, never from the caller. See '
  '164_gateway_transactions.sql.';

REVOKE ALL ON FUNCTION
  public.gateway_record_event(text, text, text, text, jsonb, text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION '
         || 'public.gateway_record_event(text, text, text, text, jsonb, text) TO app_tenant';
  END IF;
END $$;
