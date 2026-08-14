# TENANT_SECURITY_AUDIT.md

**Phase 0 deliverable. Gating document for the GMS transformation.**

Scope: `mga-backend` (all schema, migrations, routes, services, workers, jobs, storage,
integrations) and `mga-frontend` (call sites only — the frontend enforces nothing and is
audited here purely to establish which unsafe endpoints are reachable in production).

Nothing in this document is inferred from the existing automated guard. The guard
(`src/__tests__/tenantScope.convention.test.js`) derives its table list from columns named
`organization_id`, so a table that never received the column is invisible to it. **Every
confirmed leak below is on a table the guard cannot see.** That is not a coincidence — it is
the shape of the whole problem.

Method: the live table set was reconstructed from `src/db/schema.sql` plus all 183
migrations in file order, honouring `DROP TABLE`; `organization_id` presence was resolved
from static `ALTER`/`CREATE` forms **and** from the dynamic `DO $$ … EXECUTE format() …`
migrations (078–089, 140, 155–158) that a naive scan misses. Every route file was then
mapped to the tables it queries and checked for a tenant predicate by reading the handler.

---

## 0. Executive position

| Measure | Value |
|---|---|
| Live tables (post-DROP) | **144** |
| Tables carrying `organization_id` | **67** |
| Tables without it | **77** |
| …of which genuinely tenant-owned and therefore **defective** | **21** |
| Cross-tenant read paths, **live callers** | **13** at audit time — **8 remain** (V-01/02, V-09 fixed in P0; V-06 fixed in Phase 2a) |
| Cross-tenant **write/delete** paths, **live callers** | **17** at audit time — **10 remain** (V-06's seven fixed in Phase 2a) |
| Cross-tenant paths that are **latent** (inert today, live on a data or schema change) | **6** (V-05, V-11, V-12) |
| Database-level backstop | **none** — API connects as `postgres` (`rolbypassrls = true`); 247 RLS policies, **0** organization-scoped |
| `TENANT_RLS_ENFORCE` | **off** (commented out in `.env.example`) |
| Live tenants at risk | **6 studios with real client, health and payment data** |

**Assessment: the tenant boundary is enforced in one place only — hand-written SQL
predicates in Express handlers — and it is incompletely applied.** There is no second line
of defence. A single missing `AND organization_id = $n` is a production data breach, and 21
tables cannot express that predicate at all because they lack the column.

Two findings below (**V-01**, **V-02**) involve *health data* and were **not** identified in
the preceding product audit. They are the highest-severity items in this document.

---

## 1. Entity classification

Every live table is classified before any remediation is proposed, per the rule that
`organization_id` must not be added blindly.

### 1.1 TENANT — owned by exactly one organization (must carry `organization_id`)

**Correct today (67 tables).** Representative set, all verified as carrying the column *and*
being filtered at the route layer:

`pt_clients`, `pt_trainers`, `trainers`, `pt_payments`, `pt_sessions`, `pt_goals`,
`pt_assessments`, `pt_leads`, `pt_parq_forms`, `pt_medical_clearances`, `pt_consent_records`,
`pt_parq_documents`, `pt_informed_consents`, `pt_mobility_performance_assessments`,
`pt_posture_assessments`, `attendance_logs`, `invoices`, `expenses`, `communication_history`,
`activity_log`, `weekly_checkins`, `strength_logs`, `progress_photos`, `workout_plans`,
`workout_sessions`, `workout_assignments`, `diet_assignments`, `nutrition_logs`,
`client_fitness_profiles`, `storage_objects`, `login_events`, `user_webauthn_credentials`,
`membership_payments`, `payment_orders`, `payment_submissions`, `payment_audit_logs`,
`gateway_transactions`, `revenue_targets`, `organization_features`, `organization_ai_limits`,
`ai_documents`, `ai_document_chunks`, `users`.

**DEFECTIVE — tenant-owned but missing the column (21 tables).** This is the remediation
backlog:

| Table | Owner domain | Reachable via | Severity |
|---|---|---|---|
| `pt_lifestyle_assessments` | PT screening (**health data**) | `GET/PATCH /api/progress/lifestyle-assessments` | 🔴 Critical |
| `pt_nutrition_assessments` | PT screening (**health data**) | `GET/PATCH /api/progress/nutrition-assessments` | 🔴 Critical |
| `plans` | Membership plan catalogue | `GET/POST/PUT/DELETE /api/plans` | 🔴 Critical |
| `pt_packages` | PT package catalogue | `GET/POST/PATCH/DELETE /api/automation/pt-packages` | 🔴 Critical |
| `pt_plans` | PT plan catalogue | `POST /api/pt-os/clients` (lookup) | 🟠 High |
| `pt_commissions` | Trainer commission ledger | `GET /api/pt-os/commissions`, `POST /commissions/calculate` | 🟠 High *(latent — V-05)* |
| `pt_payouts` | Trainer payout ledger | `GET /api/pt-os/payouts`, `POST /payouts/mark-all-paid` | 🟠 High *(latent — V-05)* |
| ~~`system_settings`~~ | All studio configuration + branches + permissions | `GET/PUT /api/settings/*` | ✅ **Fixed — Phase 2a** (migration 167) |
| `offers` | Promotions | `GET/POST/PUT/DELETE /api/offers` | 🔴 Critical |
| `campaigns` | Marketing | `GET/POST/PUT/DELETE /api/campaigns` | 🔴 Critical |
| `feedback` | Member feedback (**PII**) | `GET/PATCH /api/feedback` | 🔴 Critical |
| `integrations` | Third-party connections | `GET/POST /api/integrations` | 🟠 High |
| `leave_requests` | Trainer leave | `GET/POST/PATCH /api/leave` | 🟠 High |
| `class_templates` | Group classes | `GET /api/classes/sessions` | 🟠 High |
| `class_sessions` | Group classes | `GET /api/classes/sessions` | 🟠 High |
| `bookings` | Class bookings | `/api/bookings`, `/api/v1/bookings` | 🟠 High |
| `automation_rules` | Automation | `GET/POST/PUT/DELETE /api/automation/rules` | 🟠 High |
| `session_balance` | PT session credits | `GET/POST /api/automation/session-balance` | 🟠 High |
| ~~`branches`~~ | Branch directory | `GET/POST/PUT/DELETE /api/settings/branches` | ✅ **Fixed — Phase 2a**; adopted as the real branch entity |
| `qr_tokens` | Check-in tokens | `/api/qr/*` | 🟡 Medium |
| `receipt_counter` | Receipt numbering | `src/db/receipts.js` | 🟡 Medium |

### 1.2 RELATIONSHIP — child rows, tenancy inherited through a gated parent FK

These legitimately have no `organization_id`; their safety is a property of the parent
lookup being org-guarded *before* the child query runs.

`invoice_items` (→ `invoices`), `workout_exercises` / `workout_sets` /
`workout_session_exercises` (→ `workout_sessions` / `workout_plans`), `meals` /
`diet_plan_meals` (→ `diet_assignments`), `pt_family_medical_history` (→ `pt_parq_forms` —
explicitly reasoned in migration 088), `support_ticket_messages` (→ `support_tickets`),
`weight_logs` / `body_metrics` (→ `pt_clients`), `exercise_versions` (→ `exercises`),
`subscription_coupon_redemptions` (→ `subscription_coupons`).

**Verified safe:** `weight_logs` in `routes/clients.js:250` runs only after the
org-guarded `pt_clients` fetch at `:219` has 404'd a foreign id.

**Structural caveat:** this pattern is correct but *fragile* — it holds only while every
call site remembers to gate the parent first. It is acceptable for now and is exactly what
RLS is meant to backstop. Recorded, not remediated.

### 1.3 USER — scoped to one user account, not one organization

`refresh_tokens`, `webauthn_challenges`, `webauthn_credentials`, `user_profiles`,
`ai_conversations`, `ai_messages`, `notifications`, `exercise_favorites`,
`exercise_recent_usage`, `google_calendar_tokens`.

Verified: `modules/notifications/notifications.routes.js` keys `inbox`, `markRead` and
`markAllRead` on `req.user.id`. **Adding `organization_id` here would be wrong** — the user
already implies the organization. One exception is carried as **V-11** below.

### 1.4 GLOBAL — shared platform reference data, intentionally NULL-org

`exercises` (890 rows, all NULL org — the shared library), `muscles`, `exercise_categories`,
`exercise_muscles`, `exercise_relations`, `equipment_types`, `muscle_volume_landmarks`,
`diet_templates`.

These carry a *nullable* `organization_id` so a studio can add private rows alongside the
shared catalogue. `TENANT-RLS-PLAN.md` records the verified reason: a strict policy here
would empty the 890-row library for all six studios simultaneously. **Do not change.**

### 1.5 PLATFORM — control plane, above the tenant boundary

`organizations`, `studio_registrations`, `platform_features`, `plan_features`,
`subscription_plans`, `subscription_coupons`, `platform_ai_settings`, `ai_model_rates`,
`ai_platform_settings`, `platform_announcements`, `platform_billing_settings`,
`platform_payment_settings`, `system_alerts`, `system_logs`, `storage_accounting_meta`,
`admin_reset_intents`, `agent_tasks`, `agent_audit_log`, `feature_flags`.

Guarded at the mount by `requireSuperAdmin` + `requireSuperAdminMfa`. **Do not add
`organization_id`** — `organizations` is the tenant *root*, and the rest are deliberately
cross-tenant. Correct as-is.

### 1.6 LEGACY / ABANDONED — zero rows, no live read path

`members`, `member_memberships`, `payments`, `clients`, `holds_freezes`, `trials`,
`trial_sessions`, `membership_actions`, `churn_risk_log`, `staff_new`, `staff_targets_new`,
`biometric_attendance`, `webauthn_credentials` (superseded by `user_webauthn_credentials`),
`face_descriptors`, `face_checkin_logs`, `audit_log`, `communication_logs`,
`google_calendar_events`.

Handled in `docs/LEGACY_SYSTEM_INVENTORY.md`. **Not** remediated here: adding
`organization_id` to a table scheduled for deletion is wasted migration surface. They are
listed so nobody mistakes their absence from the remediation plan for an oversight.

---

## 2. Vulnerabilities

Severity: 🔴 Critical (cross-tenant read or write of real data, live caller) ·
🟠 High (cross-tenant path, limited data or no live caller) · 🟡 Medium · 🔵 Low.

### V-01 🔴 Cross-tenant read/write of PT lifestyle assessments (health data) — **NEW**

`src/modules/progress/progress.routes.js:664`

```js
router.get('/lifestyle-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_lifestyle_assessments ${whereSql} ORDER BY assessment_date DESC`, params);
```

`GET /api/progress/lifestyle-assessments` with **no** `client_id` executes a bare
`SELECT *` and returns **every studio's** lifestyle assessments. Columns include
`smoking_status`, `cigarettes_per_day`, `years_smoking`, `alcohol_status`,
`drinks_per_week`, `stress_level`, `sleep_quality`, `energy_level`, `coach_notes`.

`PATCH /lifestyle-assessments/:id` (`:726`) reads `WHERE id = $1` with no org predicate and
then writes — a full cross-tenant update.

Any authenticated account of any role reaches this: the mount carries `auth` only.

**Root cause is provable and narrow.** Every sibling domain in this same file — goals,
weekly check-ins, strength logs, progress photos, mobility, posture, assessments — applies
`tenantScope(req)` correctly (e.g. `:441`, `:493`). Migration `156_mobility_posture_
organization_id.sql` tenant-scoped mobility and posture; **lifestyle and nutrition were
never given the column**, so the same author writing the same handler had no column to
filter on. The missing column *is* the defect.

### V-02 🔴 Cross-tenant read/write of PT nutrition assessments (health data) — **NEW**

`src/modules/progress/progress.routes.js:888` and `:959`. Identical shape to V-01. Exposed
columns include `food_allergies`, `medical_conditions`, `medical_notes`,
`digestive_issues`, `supplements`, `alcoholic_drinks_per_week`, `nutrition_budget`.

Note both POST handlers (`:675`, `:899`) **do** call `clientInOrg(req, b.client_id)` — so
writes-by-create are guarded while reads and updates are not. The inconsistency is further
evidence this is an oversight, not a design.

### V-03 🔴 Membership plan catalogue is platform-global

`src/routes/plans.js`. Zero occurrences of `tenantScope`/`orgIdOf`/`organization_id`.

- `GET /api/plans` — `SELECT * FROM plans WHERE …` — leaks every studio's plan names,
  base/discount/final amounts, joining fees, tax rates.
- `PUT /api/plans/:id` — `UPDATE plans … WHERE id=$15` — rewrites any studio's plan.
- `DELETE /api/plans/:id` — `UPDATE plans SET deleted_at=NOW() WHERE id=$1` — soft-deletes
  any studio's plan.

Live caller: `mga-frontend/src/app/(chrome)/finance/verify-payments/page.tsx:669` →
`api.membershipPlans.list()`. The GET hands the attacker the very ids the PUT/DELETE need.

### V-04 🔴 PT package catalogue is platform-global

`src/modules/automation/automation.routes.js:125–161`. `GET`, `POST`, `PATCH` and a **hard**
`DELETE FROM pt_packages WHERE id = $1` — all unscoped.

Live caller: the **Packages → Session Packages** page
(`subscription/packages/page.tsx:98` → `api.automation.ptPackages.*`). This is a
first-class nav item, not a dark corner.

### V-05 🟠 Trainer commission and payout ledgers are platform-global — **latent, not live**

> **Severity corrected during this audit.** The preceding product audit called this
> critical and live. It is structurally unscoped, but it is **inert today**, and the
> distinction changes the remediation order. The evidence is below; the correction is
> stated rather than quietly applied because it moves this item out of the P0 blocking set.

`src/modules/pt-os/pt-os.service.js` — none of these four functions take or apply an org:

| Function | Line | Effect |
|---|---|---|
| `calculateMonthlyCommissions(month)` | `:4` | Reads **all** tenants' `pt_clients ⋈ pt_trainers`, writes commission rows for all of them |
| `getTrainerPayouts(month)` | `:48` | Returns every studio's trainers, commission totals, payout status |
| `getCommissionHistory(trainerId)` | `:227` | With no trainer id (the admin call) returns every studio's commissions **including client names** |
| `createPayout(trainerId, …)` | `:245` | No org check on `trainerId` — creates a payout against a foreign studio's trainer |

Plus `pt-os.routes.js:1032`:

```js
UPDATE pt_payouts SET status = 'paid', paid_at = NOW(), updated_at = NOW()
 WHERE month = $1 AND status != 'paid'
```

`POST /api/pt-os/payouts/mark-all-paid` is a **platform-wide financial write**. One studio's
admin marks every studio's trainer payouts as paid, for that month, in one request.

This sits inside a file that otherwise uses `orgWhere()` correctly in ~30 places — again,
the two tables involved (`pt_commissions`, `pt_payouts`) are the ones without the column.

**Why it is inert today.** All four service functions resolve trainers through
`pt_trainers`, and `pt_trainers` has no rows and is never written to:

- `145_pt_trainer_fks_point_at_trainers.sql` records the verified production counts —
  `trainers` 6 rows, `pt_trainers` **0 rows** — and states that `pt_sessions`,
  `pt_commissions` and `pt_payouts` were all empty for the whole life of the tables.
- `POST /api/pt-os/trainers` (`pt-os.routes.js:130`) inserts into `trainers`, with an
  explicit comment that this is deliberate: *"Insert into the canonical trainers table
  (not pt_trainers)"*.

Therefore: `getTrainerPayouts` (`FROM pt_trainers t`) returns `[]`;
`calculateMonthlyCommissions` (`JOIN pt_trainers t`) matches nothing and writes nothing;
`createPayout` (`WHERE t.id = $2` against `pt_trainers`) always throws `Trainer not found`,
so `pt_payouts` stays empty and `mark-all-paid` updates zero rows.

**Why it still must be fixed.** This is the same trap `server.js` documents for the deleted
`/api/v1/reports`: *"harmless in practice only because they read the abandoned tables — that
is precisely what made them dangerous to keep."* Phase 8 (Staff) will reconcile the
`trainers` / `pt_trainers` split. **On the day it does, five endpoints begin serving and
writing cross-tenant financial data with no code change and nothing to notice it.**

Remediation is therefore mandatory but belongs with the Phase 8 work, not in the P0
blocking set — with one exception carried forward: `mark-all-paid`'s unbounded `UPDATE …
WHERE month = $1` should get its org predicate in P0-B regardless, because it costs one
line and the blast radius if the analysis above is ever wrong is every studio's payout
ledger.

### V-06 ✅ RESOLVED (Phase 2a) — `system_settings` was one global key/value table

> **Fixed by migration 167 and the rewrite of `routes/settings.js`.**
> `organization_settings`, keyed `(organization_id, key)`, gives each studio its
> own configuration; `branches` became a real tenant-owned table.
>
> The migration needed no production count, unlike the sixteen tables in §5, and
> the difference is worth keeping: configuration keys were shared **by design**,
> so every studio was already reading the same row — copying that value to each
> studio changes nothing for anyone. Branches were the opposite and needed real
> attribution, which they had: `POST /branches` has always stamped `updated_by`,
> so the creating admin's organization owns the branch. One branch in the test
> fixture had no creator and was **reported rather than guessed**.
>
> `system_settings` rows are left in place and simply no longer read, so the
> change reverses by reverting code rather than restoring data. `internal_*` keys
> stay there and stay operator-only.
>
> Covered by `settings.tenantIsolation.test.js` (19 tests) and the rewritten
> `settings.branchDelete.test.js`. The original finding follows.

### V-06 (original) 🔴 `system_settings` is one global key/value table

`src/routes/settings.js`. There is exactly one row per key for the **entire platform**.

- `GET /api/settings` — returns all platform settings to any authenticated user (non-admins
  get a prefix filter only).
- **Branches** are `branch_*` keys in this table (`:93`, `:110`, `:135`, `:158`, `:181`).
  `POST/PUT/DELETE /api/settings/branches` therefore create, edit and **delete other
  studios' branches**.
- **Permissions** (`GET/PUT /api/settings/permissions`, `:302`, `:319`) are global keys —
  one studio's permission toggles apply to all six.
- `gym_name`, gym/biometric/geo configuration are likewise shared. Migration
  `096_rebrand_gym_name.sql` updates the single global row, which is only coherent because
  the table was never tenanted.

This is the single largest architectural defect in the audit: **there is no per-studio
configuration store at all.**

### V-07 🔴 Offers, campaigns and feedback are platform-global

`src/routes/offers.js:10`, `src/routes/campaigns.js:10`, `src/routes/feedback.js:10` — all
`auth, adminOnly` with no tenant predicate on tables with no org column.

- Offers: leaks promo `code`, `discount_type`, `discount_value`, `audience`, usage counts.
- Campaigns: leaks campaign names, audiences, send/open/conversion counts.
- Feedback: leaks `member_name`, `rating`, `message`, `reply` — **member PII**.

All three are live nav items under Communication.

### V-08 🟠 Integrations are platform-global

`src/routes/integrations.js:11` — `SELECT id, name, status, connected_at, last_sync_at FROM
integrations ORDER BY id`, no org. Connection state for third-party services is shared and
mutable across tenants.

### V-09 🟠 Trainer leave requests are platform-global

`src/routes/leave.js:50`, `:90`, `:155`, `:165`. List, get-by-id, overlap-check and approve
all address `leave_requests` with no org predicate. Any admin approves any studio's leave.

### V-10 🟠 Group classes and bookings are platform-global

`src/routes/classes.js:9` — `class_sessions ⋈ class_templates` with no org filter and no org
column. `modules/bookings/bookings.service.js` carries the same shape and additionally
targets the abandoned `members` / `member_memberships` tables.

### V-11 🟠 Notification broadcast crosses tenants

`modules/notifications/notifications.service.js:282` — `recipientFromMember(memberId)` does
`SELECT … FROM clients|members WHERE c.id = $1` with no org check.
`POST /api/v1/notifications/broadcast` (`notifications.routes.js:28`, `admin`/`manager`)
therefore accepts a foreign `member_id`. Currently inert only because both tables are empty
— it becomes live the moment the member domain is built in Phase 2. **Must be fixed before
Phase 2 lands.**

### V-12 🟠 Generic module store has no tenant scope

`src/modules/operations/operations.routes.js` — zero org references; scoping is
branch-only. All four handlers query `module_records`, **a table no migration creates**, so
every request 503s today. It is inert by accident, not by design: creating that table turns
this into an immediate leak. See `docs/LEGACY_SYSTEM_INVENTORY.md`.

### V-13 🟡 `automation_rules` and `session_balance` unscoped

`modules/automation/automation.routes.js` — `/rules` CRUD and `/session-balance` carry no
tenant predicate. `session_balance` is PT session credit, i.e. a financial entitlement.

### V-14 🟡 `qr_tokens` and `receipt_counter` unscoped

QR check-in tokens are single-use and short-lived, and `receipt_counter` is a numbering
sequence — low data value, but a shared counter means receipt numbers are drawn from one
global sequence across all studios, which is a correctness problem as well as a
tenancy one.

### V-15 🔵 `pt_plans.name` is globally unique

`011b_pt_os_module.sql:27` — `name TEXT NOT NULL UNIQUE`. Two studios cannot both have a
package called "Basic PT". A tenant-scoped `UNIQUE (organization_id, name)` is required.
Same class of defect to check on every table that gains the column.

### V-17 🔵 `feature_flags` is global — but the table is already superseded

**Found during Phase 2a**, while tenanting the rest of `routes/settings.js`.

`GET`/`PUT /api/settings/feature-flags` read and write `feature_flags`, which has
no `organization_id`. An admin toggling a flag toggles it for every studio.

Deliberately **not** fixed with the rest of V-06, and the reasoning is the point:

- `feature_flags` is the pre-multi-tenant flag table. Migration 123 replaced it
  with `platform_features` + `organization_features` + `plan_features`, resolved
  per studio by `lib/features.js` — which is what `gate()` in `server.js` and the
  whole Control Centre actually use.
- **Both endpoints have no caller.** `settings.getFeatureFlags` and
  `settings.updateFeatureFlags` are defined in the frontend's api barrel and
  invoked from nowhere — the same shape as the dead `member.get` /
  `member.metrics` that `MEMBERS-TENANT-GAP.md` found before `/api/v1/members`
  was deleted.

Adding `organization_id` to a table that has already been replaced would be
building on the thing being retired. The real options are removal or migration
onto the feature manager, both of which are legacy-cleanup decisions with their
own evidence to gather. Classified **DEPRECATE** in
`docs/LEGACY_SYSTEM_INVENTORY.md`.

Severity is 🔵 rather than 🟠 because there is no caller and no live effect
today. It is recorded so the absence is a decision rather than an oversight.

### V-16 🔵 No database backstop

Recorded for completeness, from `db/migrations/TENANT-RLS-PLAN.md` (verified against
production, not inferred): the API connects as `postgres` with `rolbypassrls = true`; of 247
RLS policies in `public`, **zero** are organization-scoped; `TENANT_RLS_ENFORCE` ships off.
Every finding above is therefore un-backstopped. This is a *project*, not a patch — the
plan document is sound and its rollout order should be followed.

---

## 3. Worker and background-job audit

| Worker | Tenant context | Verdict |
|---|---|---|
| `renewal.worker.js` | `runWithTenantContext` per org **and** explicit `organization_id` filters (`:112`, `:141`) | ✅ Correct pattern. Enumerates orgs on `platformPool` (tier-3 role), everything else on the tenant pool. **However it reads the abandoned `members`/`member_memberships`/`plans` tables — functionally dead.** Re-target in Phase 14, do not rewrite the tenancy |
| `subscription.worker.js` | org-scoped | ✅ |
| `notifications.worker.js` | delegates to `notifications.service` | ⚠️ Inherits **V-11** |
| `email.worker.js`, `whatsapp.worker.js` | per-message, recipient resolved upstream | ⚠️ Safe only if the enqueuer scoped correctly |
| `ai.worker.js` | org-scoped via `organization_ai_limits` | ✅ |
| Command Centre collectors | deliberately platform-wide, behind `requireSuperAdmin` + MFA | ✅ By design |

**No worker performs an unscoped `SELECT * FROM <tenant_table>`.** The worker layer is in
better shape than the HTTP layer. `QUEUE-WORKER-TENANT-SECURITY.md` already documents the
trust boundary and is accurate.

## 4. Storage and integrations

- `storage_objects` carries `organization_id`; `lib/fileStorage.js` and
  `lib/storageLedger.js` scope by it. ✅
- `uploads.js` is category-guarded with test coverage
  (`__tests__/security/uploads.categoryCoverage.test.js`). ✅
- Google Calendar: `google_calendar_tokens` is USER-scoped ✅;
  `lib/google-calendar.js:182` joins `branches`/`class_sessions`/`class_templates`
  unscoped — inherits **V-10**.
- Razorpay webhook: signature-verified, tenant resolved from the stored order, idempotent
  via `gateway_transactions`. ✅ Best-in-repo.

---

## 5. Remediation plan

Ordered by dependency. **P0-A and P0-B must both land before Phase 2 begins.**

### P0-A — Schema: give tenant-owned tables a tenant column

One migration, additive and idempotent, following the established `088`/`156` pattern:
`ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL`,
create `idx_<table>_organization_id`, then backfill.

| Table | Backfill derivation | Confidence |
|---|---|---|
| `pt_lifestyle_assessments` | `← pt_clients.organization_id` via `client_id` | Exact |
| `pt_nutrition_assessments` | `← pt_clients.organization_id` via `client_id` | Exact |
| `pt_commissions` | `← pt_clients.organization_id` via `client_id` (FK repointed to `pt_clients` by migration 017) | Exact |
| `pt_payouts` | `← trainers.organization_id` via `trainer_id` (FK repointed to `trainers` by migration 145 — **not** `pt_trainers`) | Exact |
| `session_balance` | ⚠️ `client_id` references the **legacy empty `clients`** table, not `pt_clients` — no derivation available. Treat as a no-owner table (see gate) | None |
| `leave_requests` | `← trainers.organization_id` via `trainer_id` | Exact |
| `class_sessions` | `← class_templates` once that is backfilled | Derived |
| `plans`, `pt_plans`, `pt_packages`, `offers`, `campaigns`, `feedback`, `integrations`, `automation_rules`, `class_templates`, `bookings`, `qr_tokens`, `session_balance` | **No derivable owner.** Requires a read-only production count first | ⚠️ **See gate below** |
| ~~`system_settings`~~, ~~`branches`~~ | Done in Phase 2a. Neither needed the gate: configuration was shared by design so fan-out was behaviour-preserving, and branches carried their creator in `updated_by` | ✅ |

**Backfill gate — mandatory, and the reason this cannot be a blind migration.** For every
table in the last row, run a read-only count against production *before* writing the
backfill (this is the method `MEMBERS-TENANT-GAP.md` established and it worked):

```sql
SELECT count(*) AS rows,
       count(*) FILTER (WHERE <derivable predicate>) AS attributable
  FROM <table>;
```

- **0 rows** → backfill is a no-op; add the column `NOT NULL` immediately.
- **Rows, all attributable to one studio** → backfill to that studio (correct while a
  single studio has used the feature; this is precisely what migration 088's final fallback
  does, and it is safe *only* under that verified condition).
- **Rows spanning studios with no derivable owner** → **stop.** Do not guess. Escalate; the
  data has to be attributed by hand or the feature quarantined.

Then, and only then, a follow-up migration sets `NOT NULL` — matching the two-step approach
`155_organization_id_not_null.sql` already uses. Never in the same migration as the backfill.

Also in P0-A: replace `pt_plans`'s global `UNIQUE (name)` with `UNIQUE (organization_id,
name)` (**V-15**), and audit every other unique constraint on a newly-tenanted table for the
same defect.

### P0-B — Routes: apply the predicate

For each endpoint in §2, apply the pattern already used correctly elsewhere in the same
files — `tenantScope(req)` for reads, `orgIdOf(req)` for the stamp on writes,
`clientInOrg(req, id)` for foreign-key acceptance:

```js
const scope = tenantScope(req);
if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
```

Writes must carry the predicate in the `WHERE`, never merely in a preceding `SELECT`:

```sql
UPDATE plans SET … WHERE id = $1 AND organization_id = $2
```

Specific structural fixes beyond the mechanical predicate:

1. **V-05** — deferred to **Phase 8 (Staff)**, where the `trainers` / `pt_trainers` split is
   reconciled and this module stops being inert. When it lands: change the four service
   signatures to take an explicit `orgId` and thread it from `tenantScope(req)`. Do not add
   a default — an omitted argument must be a syntax-level error, not a silent platform-wide
   query. **Exception taken in P0-B now:** `mark-all-paid` gets its org predicate
   immediately, because it is one line and the failure mode is every studio's payout ledger.
2. **V-06** — `system_settings` needs a real decision, not a predicate. Recommended:
   introduce `organization_settings (organization_id, key, value, type, …)` with
   `PRIMARY KEY (organization_id, key)`, migrate the tenant-owned keys into it, and leave
   only genuinely platform-global keys behind. Branches must become a **first-class
   `branches` table** with `organization_id` — the orphaned table already exists and can be
   adopted rather than invented. This is the one P0 item large enough to warrant its own
   phase; it is a prerequisite for Phase 1's per-studio configuration.
3. **V-11** — add an org check to `recipientFromMember`, before Phase 2.
4. **V-12** — do not scope; **delete** the surface (see legacy inventory). Scoping a
   placeholder that queries a non-existent table is wasted work.

### P0-C — Tests

Per the phase-23 requirement, every fixed endpoint gets the five-step matrix:

```
Tenant A creates → A reads it → B cannot read → B cannot update → B cannot delete
```

covering `GET`, `POST`, `PUT`/`PATCH`, `DELETE` where each exists. Add to the existing
IDOR gate (`src/__tests__/` already carries `attendance.tenant-isolation.test.js`,
`ptOs.trainers.tenantIsolation.test.js`, `clientAuth.isolation.test.js`,
`rls.isolation.integration.test.js` as precedent).

**Also strengthen the guard itself.** `tenantScope.convention.test.js` must stop deriving
its table list solely from `organization_id` presence. Add a second assertion: any table
that is *not* in the explicit `PLATFORM_GLOBAL`, `USER_SCOPED`, `RELATIONSHIP` or `LEGACY`
allow-lists **must** carry `organization_id`. A new tenant table without the column then
fails the build instead of silently escaping the guard — which is the exact failure this
audit documents, and the only change that prevents its recurrence.

### P0-D — Database backstop

Execute `db/migrations/TENANT-RLS-PLAN.md` as written: ALS org-context plumbing behind the
off-by-default flag → `app_tenant` role and policies on a staging branch → latency
measurement → staging cutover → production. Newly tenanted tables from P0-A are picked up
automatically by migration 157's dynamic discovery, which is why P0-A must come first.

---

## 6. Required tests — checklist

| Test | Type | Blocks |
|---|---|---|
| `progress.lifestyleNutrition.tenantIsolation.test.js` | Integration + IDOR matrix | V-01, V-02 |
| `plans.tenantIsolation.test.js` | IDOR matrix incl. PUT/DELETE | V-03 |
| `ptPackages.tenantIsolation.test.js` | IDOR matrix incl. hard DELETE | V-04 |
| `ptOs.markAllPaid.orgScope.test.js` | `mark-all-paid` blast radius (P0) | V-05 (partial) |
| `ptOs.commissionsPayouts.tenantIsolation.test.js` | IDOR matrix — **deferred to Phase 8** | V-05 (full) |
| ~~`settings.tenantIsolation.test.js`~~ | Settings/branches/permissions | ✅ V-06 — shipped, 19 tests |
| `engagement.tenantIsolation.test.js` | offers/campaigns/feedback | V-07 |
| `integrations.tenantIsolation.test.js` | IDOR matrix | V-08 |
| `leave.tenantIsolation.test.js` | IDOR matrix | V-09 |
| `classes.tenantIsolation.test.js` | IDOR matrix | V-10 |
| `notifications.broadcastScope.test.js` | Foreign `member_id` rejected | V-11 |
| `tenantScope.convention.test.js` (**extend**) | Allow-list inversion | recurrence |
| `migrations.orgBackfill.test.js` | Fresh-install + backfill correctness | P0-A |
| `uniqueConstraints.tenantScoped.test.js` | No global UNIQUE on tenant tables | V-15 |

---

## 7. Nothing withheld

Every issue found during this audit is recorded above, including the two health-data leaks
(V-01, V-02) that the preceding product audit did not identify, and including V-12 and V-14
which are currently inert and could reasonably have been omitted. Items assessed as *not*
defects — the RELATIONSHIP pattern, the GLOBAL exercise library, the PLATFORM control
plane, and the USER-scoped notification inbox — are stated explicitly with their reasoning
so that a later reader does not "fix" them into breakage.

**Recommendation: do not begin Phase 2 (Member domain) until P0-A, P0-B and P0-C are
merged and green.** Phase 2 introduces the entity that every subsequent GMS domain hangs
off; building it on top of an unenforced tenant boundary would multiply the blast radius of
every finding above.
