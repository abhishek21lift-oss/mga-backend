# MY PT STUDIO — Subscription, Trial & Founder's Club

Backend-authoritative SaaS billing for studios (tenants = `organizations`),
integrated into the existing Express + `pg` + Supabase stack (no Prisma).
**Billing model: admin-activated** — studios pay out-of-band and the platform
super admin records the payment in the command centre, which activates the
subscription.

## Lifecycle

```
trial (7 days) ──pay──▶ active ──renew──▶ active
   │                       │
   └─lapse─▶ frozen        └─lapse─▶ expired ──pay──▶ active
```

`organizations.status` (`active`/`suspended`) is the super-admin hard switch and
overrides everything. `organizations.subscription_status`
(`trial`/`active`/`expired`/`frozen`/`cancelled`) is the billing lifecycle.

## Plans

| Plan | Price | Duration | Active clients |
|------|-------|----------|----------------|
| Starter | ₹1,499 | 1 mo | 5 |
| Growth | ₹3,999 | 3 mo | 15 |
| Professional | ₹6,999 | 6 mo | 30 |
| Elite | ₹9,999 (launch ₹7,999) | 12 mo | Unlimited |

**Launch offer:** Elite is ₹7,999 while founder slots remain (first 20), then
reverts to ₹9,999 — automatic, no manual change.

**Founder's Club:** the first 20 studios to activate become permanent Founder
Members with a lifetime-locked price (kept on every renewal) and `is_founder` +
`founder_number`. Slot assignment is serialized under a table lock so the last
slot can never be double-granted. The cap lives in `FOUNDER_LIMIT`
(`lib/subscription.js`) and is overridable via the `FOUNDER_LIMIT` env var.

**Seats count ACTIVE clients only.** Pending, expired, archived and completed
clients do not consume a seat, so archiving a client frees a slot immediately
(5/5 → 4/5). `clientLimitStatus()` is the single source of truth for this and is
used by both the 403 gate and the `/status` endpoint, so the number the UI shows
can never disagree with the number enforcement applies.

## Plan changes (upgrade / downgrade)

| | Upgrade | Downgrade |
|---|---|---|
| When | Immediately | End of current billing period |
| Cost | New price − unused credit | ₹0 now |
| Period | Restarts from now | Unchanged until it applies |

Proration is time-based: the unused fraction of the current period multiplied by
what the studio actually paid for it. An upgrade passes `resetPeriod` to
`activate()` — renewals stack remaining time on top, but an upgrade has already
been given that time back as cash, so stacking it too would grant it twice.

Direction is decided by **monthly rate**, not sticker price, so Growth
(₹3,999 / 3 mo = ₹1,333/mo) correctly reads as an upgrade from Starter
(₹1,499 / 1 mo) despite the larger number.

A downgrade is stored on `organizations.pending_plan_*` and applied by the
worker once it comes due; nothing changes before then. If the studio has more
active clients than the target plan allows, the quote returns a warning and the
change still proceeds — **no client is ever archived or loses access**; the
studio simply cannot add new ones until it is back under the limit.

Endpoints: `GET /api/subscription/change-quote?plan_code=`,
`POST /api/subscription/request-change`,
`POST /api/subscription/cancel-scheduled-change`, and on the operator side
`GET|POST /api/super-admin/organizations/:id/subscription/change[-quote]`,
`POST .../schedule-downgrade`, `DELETE .../scheduled-change`.

## Coupons

`subscription_coupons` (the catalogue) + `subscription_coupon_redemptions` (an
immutable ledger). `times_redeemed` is always **derived from the ledger**, never
a counter on the coupon, so it cannot drift and it answers "who used this, when,
for how much".

Percentage or fixed-amount, with optional absolute cap, minimum order, plan
allowlist, total redemption limit, per-studio limit (default 1, so one studio
cannot drain a promotion by renewing), and a validity window.

`validateCoupon()` is a **preview** — it reserves nothing. `redeemCoupon()`
re-validates under `SELECT … FOR UPDATE` on the coupon row inside the activation
transaction, so a `max_redemptions` of 1 can only ever be claimed once. Same
reasoning as the founder-slot table lock.

A founder's `locked_price_inr` is deliberately the **gross** price, not the
discounted one: the lifetime benefit is a locked *plan* price, and letting a
one-off promo become someone's permanent rate would leak revenue on every
renewal.

A redeemed coupon can be deactivated but not deleted — it is part of the billing
record. Endpoints: `GET /api/subscription/validate-coupon`, and
`GET|POST|PATCH|DELETE /api/super-admin/coupons[/:id]`,
`GET /api/super-admin/coupons/:id/redemptions`.

## Enforcement (never trust the frontend)

- **Freeze/expiry:** `middleware/auth.js` calls `subscription.computeAccess()` on
  every authenticated request and returns **402 `SUBSCRIPTION_INACTIVE`** for
  frozen/expired/suspended studios, except on the allowlist (`/api/auth`,
  `/api/profile`, `/api/subscription`, `/api/super-admin`, `/api/health`).
  Expiry is timestamp-based, so it is correct even off the 30s user cache and
  needs no cron. Super admins and impersonation bypass.
- **Client limits:** enforced server-side in the PT-OS client-create handler via
  `subscription.clientLimitStatus()` → **403 `PLAN_LIMIT_REACHED`**. Existing
  clients always stay accessible; unlimited/grandfathered studios never block.
- The frontend redirects a 402 to `/subscription` and shows the plan-limit
  message, but the block is entirely backend.

## Data model (migration 099)

`subscription_plans`, `founder_members`, `subscription_payments`,
`subscription_invoices`, `subscription_events` (billing audit), plus the
subscription columns on `organizations`. **Existing studios were grandfathered to
`active` / unlimited / no-expiry** so nothing already live is frozen; only new
studios enter the trial→paid flow.

## Worker

`src/workers/subscription.worker.js` — `runSubscriptionSweep()`:
1. Freezes lapsed trials, expires lapsed subscriptions (persists status for
   display; access is already enforced lazily).
2. Sends 7 / 3 / 1-day and expiry-day reminders + frozen notifications to studio
   admins (in-app), de-duplicated via `subscription_events`.

Idempotent + deduped, so it is safe to run repeatedly. `server.js` runs it in
process ~1 min after boot then every 6 h (disable with `SUBSCRIPTION_SWEEP=off`).
Can also run standalone: `node src/workers/subscription.worker.js`.

## Admin (command centre → Billing tab)

View all subscriptions + KPIs (revenue, active/trial/frozen, founders x/50);
record payment → activate/renew (auto-grants founder for the first 50); freeze /
reactivate (comp); change trial/renewal expiry; grant founder; cancel; refund a
payment; per-studio invoice/payment/event history. Every mutation is audited and
invalidates the user cache so it takes effect on the next request.

## Testing strategy

- **Engine unit checks:** `computeAccess` across grandfathered/trial/active/
  expired/frozen/suspended/renewal-due (verified). Founder-slot race is covered
  by the table lock.
- **Activation transaction:** validated against the live schema inside a
  `BEGIN…ROLLBACK` (founder grant + payment + invoice) with zero residue.
- **Manual end-to-end (staging or a throwaway studio):**
  1. Create a studio → confirm 7-day trial + trial banner + `trial_ends_at`.
  2. Force `trial_ends_at` into the past (command centre → change expiry) → next
     request 402s → app redirects to `/subscription` frozen screen.
  3. Record a payment (e.g. Starter) → studio active, invoice created; if within
     first 50, `is_founder` + locked price set.
  4. Add clients up to the plan limit → next create returns `PLAN_LIMIT_REACHED`.
  5. Freeze from the command centre → studio blocked; reactivate → restored, all
     data intact.
  6. Refund a payment → invoice marked refunded.

## Deployment checklist

- [ ] Backend deploy (Render) runs migration 099 on boot (idempotent; already
      applied to the live DB).
- [ ] Frontend deploy (Vercel) ships `/subscription`, the Billing tab, and the
      402→/subscription redirect.
- [ ] Confirm existing studios still show `active` / unlimited (grandfathered).
- [ ] (Optional) Set `RESEND_API_KEY` to also send reminder emails; in-app
      notifications work without it.
- [ ] `SUBSCRIPTION_SWEEP=off` only if you prefer an external cron running
      `node src/workers/subscription.worker.js` instead of the in-process sweep.
- [ ] `TRIAL_DAYS` env overrides the 7-day default if ever needed.
