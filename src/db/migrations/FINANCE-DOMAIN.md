# Finance domain

Which table money lives in, and why there are five of them. Every claim here
was measured against the database or traced through the code; where something
is unresolved it says so rather than describing an intention as a fact.

## The five tables

| Table | `organization_id` | RLS | Created by | Purpose |
|-------|-------------------|-----|------------|---------|
| `payments` | **no** | deny-all | `foundation/schema-v4` | **legacy — not canonical** |
| `pt_payments` | yes | strict | migration 018 | PT business ledger |
| `membership_payments` | yes | strict | migration | membership business ledger |
| `payment_orders` | yes | strict | migration | payment/order intent (UPI) |
| `gateway_transactions` | yes | strict | migration 164 | external provider transaction |

The three concepts are not interchangeable:

- **a payment order** is an intent to pay — it may never be paid
- **a gateway transaction** is what a provider says happened to a charge
- **a business ledger row** is money recognised against a studio's domain

One real payment can touch all three. Collapsing them loses the ability to
reconcile what the provider believes against what the business recorded.

## Why `payments` is legacy

It is the only finance table with no `organization_id` and no policy, and the
only one created by the pre-tenancy v4 foundation rather than a migration.
Every table added after the tenancy model has both.

Migration `018_complete_pt_independence.sql` already moved PT money out of it.
Membership and subscription payments then got their own tenanted tables. It was
left behind, and migration 131 gave it the deny-all that every unclassified
table received.

**Do not backfill `organization_id` into it.** Its `client_id` points at
`pt_clients`, which is exactly what 018 split away, so there is no reliable
derivation for historical rows — a backfill would be guesswork on financial
records. **Do not migrate its rows into `gateway_transactions` either**: they
are business ledger entries, not provider transactions.

## `gateway_transactions` (migration 164)

Keyed `UNIQUE (provider, provider_payment_id)`, so one row per provider
payment. `organization_id` is stored directly rather than derived through
`payment_order_id`, because RLS needs a predicate it can evaluate on the row
and that FK is nullable — a gateway charge does not always begin as an order.

`last_event_id` records which provider event last moved the row; it is what
makes a redelivery a no-op. Neither `app_tenant` nor `app_platform` is granted
DELETE: a financial record is corrected by a later row, not removed.
`app_platform` has SELECT only, for cross-studio reconciliation.

## The Razorpay producer

The only path in the backend that creates a Razorpay order:

```
renewal.worker.js → autoRenewForOrg(orgId) → razorpay.createOrder()
                  → INSERT INTO gateway_transactions
```

Verified: `razorpay.createOrder` has exactly one caller.
`upiPayments.createOrder` is unrelated — it writes a local `payment_orders` row
and never contacts Razorpay — and `routes/integrations.js` only reads
configuration.

**There is currently no HTTP endpoint that creates a Razorpay order.** If one
is added later it must create the gateway transaction too, or its payments will
arrive at a webhook with nothing to attach to.

`orgId` comes from `forEachOrganization`'s platform enumeration, never from a
request. The surrounding transaction already carries `app.org_id`, so the
INSERT satisfies the strict policy rather than working around it.
`ON CONFLICT DO NOTHING` so a retried sweep cannot fail on a charge it already
recorded.

## Still unresolved

The renewal worker also writes a business ledger row:

```sql
INSERT INTO payments (member_id, amount, method, date, gateway, gateway_txn_id, ...)
```

into the legacy table. **Phase 6H did not solve this.** `gateway_transactions`
records what the provider did; where an auto-renewal's money should be
recognised — most likely `membership_payments` — is a separate domain decision
with its own column mapping, and inventing it to make a webhook green would be
the wrong trade.

Two facts worth carrying into that decision: `payments` is deny-all under
`app_tenant`, so this INSERT already fails; and it writes `gateway_txn_id`
while the old webhook read `gateway_payment_id`, so the two never matched even
before the columns went missing.
