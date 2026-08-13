# Webhook and external callback security

Every request that reaches this backend from outside a browser session we
control. Three exist. None of them accepts a tenant identifier from the caller,
and this document records how each one establishes identity instead, what it
does when something is wrong, and what is known to be missing.

Placed beside the migrations because two of the three findings below are
schema facts, not code facts.

## Inventory

| # | Callback | Class | Route | Auth |
|---|----------|-------|-------|------|
| 1 | Razorpay | PAYMENT | `POST /api/webhooks/razorpay` | HMAC-SHA256 over the raw body |
| 2 | Google Calendar | OAUTH | `GET /api/calendar/callback` | signed `state` JWT, purpose-checked |
| 3 | Invitation pixel | TRACKING | `GET /api/invitations/track/:trackId.gif` | opaque server-generated id |

No callback is UNKNOWN. Searched for: webhook, callback, oauth, redirect,
pixel, razorpay, calendar, stripe, payment, provider, integration, signature,
hmac, state, nonce, event_id, idempotency. UPI is not in this table: all ten
routes in `routes/upi-payments.js` require `auth` — it is a manual UTR flow
with no provider callback. `middleware/serviceAuth.js` authenticates a
server-to-server caller but establishes no tenant identity; the normal `auth`
middleware still runs after it.

## Tenant identity

| Callback | Tenant source | Trust boundary | Risk |
|----------|---------------|----------------|------|
| Razorpay | provider payment id → row lookup | HMAC signature | none: no tenant id on the path |
| Calendar | `user_id` inside the signed state | JWT signature + purpose | none: keyed on user, not tenant |
| Pixel | opaque `track_id` → row lookup | unguessable identifier | none |

None reads `organization_id`, `org_id`, `tenant_id` or `branch_id` from a body
or a query. A repository-wide scan finds those identifiers on request objects
only inside `modules/platform/super-admin/`, behind `requireSuperAdmin` and
MFA, where a super admin is authorised across organisations and the parameter
is a list filter rather than an authorisation decision.

Razorpay deserves a note on why it is safe without a tenant id at all: the
`WHERE` clause matches on the provider's payment id, which Razorpay allocates
globally. One id identifies one row on the platform, so ownership follows from
the row rather than from the message. A signature proves the message came from
Razorpay; it proves nothing about which tenant it may act on, and the handler
does not treat it as if it did.

## Response semantics

| Condition | Response | Why |
|-----------|----------|-----|
| Bad/missing signature | 400 | Caller's fault; a retry cannot help |
| Malformed payload | 400 | Same |
| Unknown event type | 200 | Acknowledged and ignored, per provider contract |
| Valid event, write succeeds | 200 | — |
| Valid event, write fails | **500** | The provider must retry |

The last row was a bug until recently. The handler caught every database error
and answered `200 {received:true}`, so Razorpay was told an event was processed
that was not, correctly never resent it, and the write was lost with one log
line as its only trace. Signature and payload rejections keep their 4xx.

## Replay and idempotency

**Razorpay** has no event-id ledger. It is replay-safe only because all three
handlers set an absolute status (`captured`, `failed`, `refunded`) rather than
accumulate. `webhook.security.test.js` asserts the absence of an accumulating
write, so anything that credits a wallet or adds a commission fails the suite
instead of quietly inheriting safety it does not have.

**Calendar state is not single-use.** It is signed and expires in ten minutes,
but nothing records that it was consumed, so it can be replayed within that
window. Google's authorization codes are themselves single-use, which limits
this in practice — but the application does not rely on that and does not
enforce it. The state travels in a URL, so it reaches browser history, Referer
headers and any intermediate proxy. The fix is a durable single-use nonce; it
is not implemented, and `oauthCallback.security.test.js` pins the current
behaviour so the change has to be made deliberately rather than by accident.

**The pixel** flips one invitation from `sent` to `opened` and is idempotent by
construction. It always returns the same 1×1 GIF whether or not the id exists,
and swallows write errors, so it is not an existence oracle.

## Razorpay persistence — resolved in 6H-B2

The handler no longer writes `payments`. It calls `gateway_record_event()`
(migration 164), passing provider identifiers and nothing else:

```
raw body → HMAC-SHA256 → parse → provider payment id → gateway_record_event()
```

The function is SECURITY DEFINER because the callback is unauthenticated:
`app.org_id` is never set on that path, so `gateway_transactions`' strict
policy correctly refuses a direct write. `search_path` is pinned to
`public, pg_temp`, PUBLIC EXECUTE is revoked, and only `app_tenant` may call
it. **It has no `organization_id` parameter** — the tenant is read from the row
it finds, so a forged value in a signed payload has nowhere to go.

Response semantics, each verified:

| Condition | Response |
|-----------|----------|
| Bad or missing signature | 400, never reaches persistence |
| Malformed JSON | 400 |
| Handled event with no payment id | 400 — malformed, retry cannot help |
| Unhandled event type | 200 `applied:false` |
| Unknown provider payment id | 200 `applied:false` — fail closed |
| Duplicate event id | 200 `applied:false` |
| Database fault | **500** — the provider must retry |

Idempotency has two independent controls: `last_event_id` inside the function
(row locked `FOR UPDATE`, so concurrent deliveries cannot both decide they are
first), and `UNIQUE (provider, provider_payment_id)` on the table. Removing the
function's check still leaves the constraint — demonstrated by mutation, where
the duplicate-event assertion failed but "no duplicate row" still passed.

Covered by `api-idor-verify.js` STEP 30, inside the existing CI gate: 34/34.

**The legacy business ledger is NOT solved by this.** See FINANCE-DOMAIN.md.

## Known limitations

**Google Calendar — MEDIUM.** `google_calendar_tokens` has no
`organization_id`, so migration 157 gave it no `tenant_isolation` policy and
only migration 131's deny-all applies. As `app_tenant` the insert raises
`42501`. Confirmed directly:

```
INSERT INTO google_calendar_tokens … → 42501 new row violates row-level security policy
```

The callback fails closed and visibly — the user is redirected to
`?calendar=error&reason=token_exchange` — so this is an outage, not a leak. It
needs a tenancy decision for user-scoped integration rows, which is the same
question `payments` raises.

## CI

Covered by the existing `test` and `api-idor` gates rather than a new job:

- `webhook.security.test.js` — 14 assertions, Razorpay
- `oauthCallback.security.test.js` — 12 assertions, Calendar
- `razorpayWebhook.test.js` — pre-existing suite
- `api-idor-verify.js` — 34 assertions including STEP 30 (gateway tenant
  safety), runs as `app_tenant` with `TENANT_RLS_ENFORCE=on`

Mutation-tested: rewriting the Razorpay handler to scope its `UPDATE` by
`event.organization_id` fails the suite, including the tenant-forgery
assertion. Restored, all green, diff clean.

## Test environment secret isolation

Not a webhook concern, but it was found while chasing one and it governs every
security claim in this document: a test that can reach production proves
nothing about isolation.

`src/db/pool.js` is required by 129 files and called `dotenv.config()` at
import, so a single unmocked suite pulled the repository `.env` into the Jest
worker. Measured before the fix:

```
DATABASE_URL before requiring db/pool : unset
DATABASE_URL after                    : <production pooler host>
pool.totalCount                       : 1
```

A live connection to production, from a unit test. `.env` also carries
`JWT_SECRET`, which is worse: whatever reads it can mint a valid session for
any tenant.

The rules, enforced by `src/__tests__/testEnv.isolation.test.js`:

1. Jest never loads the repository `.env` — `pool.js` skips dotenv under
   `NODE_ENV=test`, so in a worker there is nothing to load.
2. `jest.setup.env.js` pins the three database URLs, `JWT_SECRET` and
   `FRONTEND_URL` before any module loads. Environment-provided values win, so
   CI and the `scripts/` harnesses keep their explicit contracts.
3. A test failure is never fixed by pointing a test at a real database.
4. No production database connection from Jest — asserted via
   `pool.totalCount === 0`.
5. No provider credentials in the worker; adding one has to be a deliberate,
   visible change to that test.

The isolation test is mutation-proven: with both controls removed it fails on
the production host. With only one removed it passes, because the two are
redundant for pinned keys — the dotenv guard is what protects keys nobody
thought to pin.
