# GMS_TARGET_ARCHITECTURE.md

**Phase 1 deliverable.** The target domain model for turning this system from
*PT OS with a thin gym shell* into *GMS core with PT OS as a first-class module*.

This is a design, not an implementation. Nothing here has been built. Its job is
to fix the decisions that every later phase depends on — above all the identity
model — so those phases are execution rather than argument.

Companion documents: `TENANT_SECURITY_AUDIT.md` (Phase 0, gating),
`docs/LEGACY_SYSTEM_INVENTORY.md` (what happens to the old surfaces),
`docs/GMS_MIGRATION_SCORECARD.md` (progress, evidence-based).

---

## 1. The one decision everything else hangs off

> **A member is a person who belongs to the gym. A PT client is a member who has
> bought personal training. They are not the same entity and must not be the
> same row.**

Today they are the same row. `pt_clients` carries `trainer_id`, `package_type`,
`pt_start_date`, `pt_end_date`, `monthly_pt_amount`, `trainer_commission` and
`sessions_per_week` *on the person record*. Attendance resolves against it
(`qr-checkin.js`: "pt_clients is where members actually live"), the finance
ledger is `pt_payments`, and the SaaS plan meter is `client_limit` counted over
`pt_clients`. There is no way to represent someone who pays for gym access and
never meets a trainer — which is the majority of every real gym's roster.

The target:

```
organizations
     │
     ├── users ─────────────────── staff ──── trainer_profiles
     │
     ├── members  ◄────────── the canonical person. One row per human.
     │      │
     │      ├── memberships ───── membership_plans
     │      ├── attendance
     │      ├── orders / payments / invoices
     │      ├── locker_assignments
     │      ├── class_bookings
     │      │
     │      └── pt_enrollments  ◄── OPTIONAL. Zero, one, or many over time.
     │                │
     │                ├── trainer
     │                ├── pt_package
     │                ├── pt_sessions
     │                ├── workout_plans / workout_logs
     │                ├── assessments (PAR-Q, consent, fitness, lifestyle,
     │                │                nutrition, mobility, posture, goals)
     │                └── progress (photos, strength, check-ins, metrics)
     │
     ├── membership_plans     ├── products / inventory / suppliers
     ├── leads                ├── orders (POS)
     ├── lockers              ├── expenses
     ├── classes              └── reports
```

Every box under `members` is optional except `members` itself. A gym owner who
never sells personal training must be able to run the entire business with the
`pt_os` feature switched off, and nothing in the core may reference a PT table.
That is the acceptance test for this whole transformation, and it is the same
question Phase 13 of the audit asked and answered *no* to.

---

## 2. Canonical identity model

### 2.1 The problem

Three tables describe a person today:

| Table | Rows | Has `organization_id` | Status |
|---|---|---|---|
| `clients` | **0** | no | legacy; `clients.legacy-table.test.js` fails the build if anything reads it |
| `members` | **0** | no | legacy; endpoint deleted, `membersEndpointRemoved.test.js` guards it |
| `pt_clients` | real data, 6 studios | yes | **the only live person table** |

`MEMBERS-TENANT-GAP.md` records the production verification for `members`:
0 rows, 0 organisations represented, 0 attributable rows, 0 duplicate member
codes. It is an empty shell with a foreign key from `member_memberships` and a
join in `renewal.worker.js`, and nothing else.

### 2.2 The decision

**`members` becomes the canonical person table, rebuilt rather than adopted.**
`pt_clients` is retained and becomes a **PT enrollment profile** that points at a
member. No data is moved out of `pt_clients`; a `member_id` column is added to
it, and the identity fields it carries are copied *up* into `members`.

Rejected alternatives, with reasons, so this is not relitigated:

- **Rename `pt_clients` to `members`.** Explicitly forbidden by the brief, and
  correctly so: it would make every gym member carry `trainer_commission` and
  `monthly_pt_amount`, which is the defect being fixed, not a fix.
- **Adopt the existing empty `members` table as-is.** It has no
  `organization_id` and cannot get one usefully — its `client_id` column was
  added `TEXT NOT NULL DEFAULT ''` by migration 015 and `members.service.js`
  never set it, so its rows were unattributable by construction. Migration 157's
  dynamic RLS discovery cannot cover it. Rebuilding costs nothing because there
  is nothing in it.
- **A shared `persons` table with `member` and `staff` subtypes.** Over-general.
  Staff identity already lives in `users` with a role, works, and is not what is
  broken.

### 2.3 Target shape

```
members
  id                 TEXT PK            -- gen_random_uuid()::TEXT, matching
                                        -- the convention pt_clients uses so
                                        -- FKs across the two are homogeneous
  organization_id    UUID NOT NULL REFERENCES organizations(id)
  member_code        TEXT               -- human-facing, UNIQUE per org
  name, mobile, email, dob, gender, address, photo_url
  emergency_contact, emergency_phone
  status             TEXT               -- prospect | active | inactive | expired | cancelled
  joined_on          DATE
  source             TEXT               -- walk-in | lead | import | pt
  notes              TEXT
  deleted_at, created_at, updated_at
  UNIQUE (organization_id, member_code)
  UNIQUE (organization_id, mobile) WHERE deleted_at IS NULL
```

```
pt_clients                              -- UNCHANGED except for one column
  member_id          TEXT REFERENCES members(id)   -- added, then NOT NULL
  ... every existing column stays ...
```

`pt_clients` keeps its own `organization_id` rather than inheriting through
`member_id`. Denormalised on purpose: it keeps every one of the ~30 existing
`orgWhere()` predicates in `pt-os.routes.js` correct without a rewrite, and it
keeps the table eligible for migration 157's dynamic RLS discovery. A
`CHECK`-style consistency test asserts `pt_clients.organization_id =
members.organization_id` for every row.

### 2.4 Migration of existing PT clients

Non-destructive, and reversible until the final step:

1. Add `members.*` (new table) and `pt_clients.member_id` (nullable).
2. For each existing `pt_clients` row, insert one `members` row copying
   `name, mobile, email, dob, gender, address, photo_url, emergency_*,
   organization_id`, with `source = 'pt'` and `joined_on = joining_date`.
   Set `pt_clients.member_id` to it.
3. Verify: `SELECT count(*) FROM pt_clients WHERE member_id IS NULL` must be 0
   per organization, and member/PT-client counts must match exactly.
4. Only then `SET NOT NULL` on `pt_clients.member_id`, using the
   check-then-tighten shape `155_organization_id_not_null.sql` established.

Deduplication — two `pt_clients` rows that are the same human — is **out of
scope for the migration**. The product already has `/settings/merge-duplicates`
and `POST /clients/merge-duplicates`; that surface is extended to merge members
after the fact. Attempting fuzzy identity matching inside a migration against
six live studios' data is how records get silently merged wrong.

---

## 3. Membership ≠ PT package

The two must never share a table, and the distinction is what makes the product
a GMS:

| | Gym membership | PT package |
|---|---|---|
| Grants | building access for a period | N sessions with a trainer |
| Priced by | duration | sessions and trainer |
| Consumed by | time passing | a session being delivered |
| Lives in | `memberships` ← `membership_plans` | `pt_enrollments` ← `pt_packages` |
| Can exist alone | **yes** | no — requires a member |

```
membership_plans     org-scoped catalogue: name, duration_days, price,
                     joining_fee, tax_pct, is_active
                     UNIQUE (organization_id, name)   ← never global (V-15)

memberships          member_id, plan_id, starts_on, ends_on, status,
                     price_paid, order_id
                     status: pending | active | frozen | expired | cancelled

membership_freezes   membership_id, from, to, days, reason, created_by
                     -- ends_on is extended by the frozen days on resume
membership_events    membership_id, kind (renew|upgrade|downgrade|cancel|
                     transfer), from_plan, to_plan, effective_on, actor, note
```

`membership_events` is one table rather than the four the brief lists
(`membership_renewals`, `membership_cancellations`, `membership_changes`, …).
They share every column and differ only in `kind`; four tables would mean four
sets of reports, four backfills and four places to forget a tenant predicate.
Freezes stay separate because they carry a date range and mutate `ends_on`,
which the others do not.

**The existing `plans` table is not reused.** It is untenanted (V-03), mixes
`kind IN ('Membership','PT')` in one catalogue, and is read by the live UPI
checkout path. It is migrated, then retired — see the legacy inventory.

---

## 4. Attendance decoupling — cheaper than expected

`attendance_logs` is **already polymorphic**:

```sql
ref_id    TEXT NOT NULL,
ref_type  TEXT NOT NULL DEFAULT 'client' CHECK (ref_type IN ('client','trainer')),
UNIQUE (ref_id, ref_type, date)
```

The table never bound itself to PT. Only the *resolution logic* did —
`qr-checkin.js` looks `ref_id` up in `pt_clients` to find a name and a
membership status. So Phase 4 is:

1. Widen the CHECK to `('member','client','trainer')`.
2. Resolve `ref_type = 'member'` against `members ⋈ memberships` for the
   name and access decision.
3. Keep `'client'` working unchanged, so historical rows and the PT check-in
   path are untouched.
4. New check-ins are written as `'member'` once every PT client has a member.

No table rewrite, no data migration, and the existing
`attendance.tenant-isolation.test.js` and `singleCheckinSurface.test.js` keep
their meaning. This is the single largest piece of good news in the plan.

---

## 5. Unified billing

The brief asks for `customers / orders / order_items / payments / invoices /
refunds`. The existing payment infrastructure is the strongest part of the
codebase — Razorpay webhook with signature verification and
`gateway_transactions` idempotency, manual UPI with UTR verification and
duplicate-activation constraints, invoices with items and receipt numbering — and
the brief is explicit that it must be preserved.

So: **add an order layer above the existing ledger; do not replace it.**

```
orders            org, member_id, status, subtotal, discount, tax, total, source
order_items       order_id, kind, ref_id, description, qty, unit_price, total
                  kind: membership | pt_package | product | locker | other
payments          EXISTING (pt_payments + membership_payments + payment_orders
                  keep working) — gains a nullable order_id
invoices          EXISTING — gains a nullable order_id
refunds           NEW — payment_id, amount, reason, actor, gateway_ref
```

`order_items.kind` is what makes one POS sell a membership, a PT package and a
protein bar in a single transaction. `payments.order_id` is nullable so every
existing payment row stays valid and the gateway/UTR paths are untouched; new
sales flow through an order, old ones remain directly attached. Nothing about
Razorpay, UPI, UTR, receipts or idempotency changes.

---

## 6. Staff vs trainer

`staff` and `staff_targets` were dropped by `064_drop_staff_module.sql` (both
empty, verified). `trainers` is the only personnel table and holds 6 real rows.

Target: **`staff` is the personnel record; trainer is a role a staff member
holds.**

```
staff              org, user_id (nullable — not every employee logs in),
                   name, mobile, email, employee_code, designation,
                   date_of_joining, status, compensation fields
staff_roles        staff_id, role   -- admin | manager | reception | trainer
trainer_profiles   staff_id PK, specialization, incentive_rate, bio, ...
```

`trainers` is migrated into `staff` + `trainer_profiles`. This is the phase that
also reconciles the `trainers` / `pt_trainers` split — which is exactly when
V-05 (commissions and payouts) stops being inert, so **the V-05 scoping fix is a
prerequisite of this phase, not a follow-up**.

---

## 7. CRM

`pt_leads` is real, org-scoped and works. It is *specialised*, not general: its
`converted_client_id` points at `pt_clients`, so a lead can only become a PT
client.

Target: generalise in place rather than build a second lead table.

```
leads   ... existing pt_leads columns ...
        interest        TEXT   -- membership | pt | class | other
        converted_member_id  TEXT REFERENCES members(id)
        converted_client_id  TEXT REFERENCES pt_clients(id)  -- kept, PT only
```

Renaming `pt_leads` to `leads` is deferred to the cleanup phase; the column
additions are what unblock general CRM.

---

## 8. Per-studio configuration — the prerequisite nobody asked for

`system_settings` is a single global key/value table (V-06). Studio name,
branches, permissions, biometric and geo config are shared across all six
studios today. **There is no per-studio configuration store at all.**

Almost every phase below needs one: memberships need tax and currency defaults,
POS needs receipt prefixes, lockers need rental defaults, notifications need
per-studio templates and sender identity.

```
organization_settings   organization_id, key, value, type, updated_by, updated_at
                        PRIMARY KEY (organization_id, key)
system_settings         RETAINED for genuinely platform-global keys only
branches                org, name, location, status, is_default
                        -- a real table; the orphaned `branches` table is adopted,
                        -- and `branch_*` keys migrate out of system_settings
```

This is promoted to **Phase 2a**, immediately after the member domain and before
memberships, because everything downstream reads it.

---

## 9. Feature flags

The existing feature manager (`lib/features.js`, migration 123) is good and is
kept. The catalogue is restructured so core GMS is core:

| Tier | Features |
|---|---|
| **Core** (`is_core = TRUE`, not switchable) | `members`, `memberships`, `attendance`, `finance`, `settings` |
| **Standard** (default on) | `pos`, `inventory`, `staff`, `crm`, `lockers`, `reports`, `classes`, `communication` |
| **Optional** (default on, genuinely removable) | `pt_os`, `ai_suite`, `ai_knowledge_base`, `member_portal`, `integrations`, `branches`, `passkeys` |

The change that matters: `clients` and `sessions` stop being the two core
features. `pt_os` becomes a single optional feature gating the whole module —
which is what makes the Phase 13 question ("remove PT OS, is it still a GMS?")
answerable by flipping a flag instead of by argument.

---

## 10. API surface

Core GMS moves out of the PT namespace. PT keeps its own.

```
/api/members            /api/memberships        /api/membership-plans
/api/attendance ✅      /api/orders             /api/products
/api/inventory          /api/suppliers          /api/expenses ✅(no UI)
/api/staff              /api/leads              /api/lockers
/api/classes            /api/reports ✅         /api/settings ✅(needs tenanting)
/api/payments ✅        /api/invoices ✅

/api/pt-os/*  ← enrollments, packages, sessions, programs, assessments,
                progress, commissions, payouts, PT analytics
```

`✅` = exists and is tenant-safe today. Business endpoints currently under
`/api/pt-os` (`/clients`, `/leads`, `/payments`, `/revenue`, `/balance-sheet`,
`/activity-log`, `/dashboard`) are re-homed, with the old paths kept as thin
delegating aliases for one release — the same policy `server.js` already applies
to `/api/auth` vs `/api/v1/auth`.

---

## 11. Sequence, with the dependencies that actually bind

```
P0   Tenant security          ── DONE for the derivable set; 16 tables gated
                                 on a production count
1    This document            ── DONE
2    Member domain            ── blocks everything
2a   Per-studio settings      ── §8; blocks memberships, POS, lockers, notifs
3    Membership domain        ── needs 2, 2a
4    Attendance decoupling    ── needs 2 (cheap, §4)
5    Unified billing          ── needs 2, 3
6    POS                      ── needs 5
7    Inventory                ── needs 6
8    Staff                    ── independent; MUST carry the V-05 fix (§6)
9    CRM                      ── needs 2
10   Lockers                  ── needs 2, 5
11   Expenses UI              ── independent; API already exists
12   Classes                  ── needs 2; currently unscoped (V-10)
13   GMS reports              ── needs 3, 5, 6, 7
14   PT OS repositioning      ── needs 2, 3; pt_clients → member_id
15   Navigation               ── LAST. No nav item ships before its module
16   Legacy cleanup           ── needs everything
17   Final QA
```

Two orderings differ from the brief and both are deliberate: per-studio settings
is inserted as 2a because nine later phases read it, and staff is flagged as the
phase that must carry the V-05 fix because it is the phase that makes V-05 live.

---

## 12. Invariants

Every phase is checked against these. A change that breaks one is wrong
regardless of what it delivers.

1. **No core GMS table references a `pt_*` table.** PT depends on core; core
   never depends on PT.
2. **Every tenant-owned table carries `organization_id`**, and every query
   naming it carries the predicate. New tables are born `NOT NULL`.
3. **Uniqueness is tenant-scoped.** `UNIQUE (organization_id, …)`, never a bare
   `UNIQUE (name)` (V-15).
4. **Turning `pt_os` off leaves a working gym.** Enforced by test, not by
   inspection.
5. **No screen ships without its API, and no API without its tenant test.** No
   placeholder records, no fake dashboards, no seeded demo data.
6. **PT data is never deleted or renamed.** Additive migrations; `pt_clients`
   keeps every column it has.
7. **Working payment infrastructure is not replaced.** Razorpay, UPI, UTR,
   gateway idempotency, receipts and invoices keep their code paths.
8. **Dates are `DATE`/`TIMESTAMPTZ`.** No new `TEXT` dates; existing ones
   (`pt_clients.dob`, `pt_start_date`, `pt_end_date`) are converted in the
   cleanup phase, not opportunistically.
