# LEGACY_SYSTEM_INVENTORY.md

**Phase 17 deliverable, produced early because Phases 2–14 need to know what
they are allowed to touch.**

Every dead, duplicated, abandoned or placeholder surface found in the audit,
classified **KEEP / MIGRATE / REPLACE / DEPRECATE / DELETE**.

Nothing is deleted on the strength of this document. A `DELETE` classification
records that the six proofs below have been *checked in the repository*; the
production-data proof requires a read-only count that has to be run against the
live database before the deletion migration is written. Where that count is
still outstanding it is stated.

**The six proofs required before any deletion:**
1. no active route depends on it · 2. no worker depends on it ·
3. no migration depends on it · 4. no production data depends on it ·
5. no frontend depends on it · 6. no API contract depends on it

---

## 1. The generic module system — the largest fake surface

| Item | Class | Evidence |
|---|---|---|
| `module_records` table | **DELETE (nothing to delete)** | Referenced by `operations.routes.js` at four call sites. **No migration anywhere creates it.** Every request 503s |
| `src/modules/operations/operations.routes.js` | **DELETE** | Queries the above; carries no tenant scope (V-12); mounted at `/api/modules` |
| `mga-frontend/src/lib/module-config.ts` (~560 lines) | **DELETE** | Config for ~40 modules, ~19 unreleased. `seedRecords()` fabricates records with invented Indian names |
| `mga-frontend/src/components/modules/ModuleWorkspace.tsx` | **DELETE** | Renders the above |
| `mga-frontend/src/lib/module-service.ts` | **DELETE** | Client for `/api/modules/:key` |
| `/reports/{overview,attendance,trainers,revenue,dues,staff,monthly,renewal,traffic}` | **REPLACE** | Nine "All Reports" tabs, all 503. Replaced by real reports in Phase 13 |
| `/appointments` | **DEPRECATE** | 503s. Bookings/classes cover the intent (Phase 12) |
| `/settings/biometric` | **DEPRECATE** | 503s. `/admin/biometrics` is the real page |
| `finance/[tab]`, `insights/[tab]`, `engagement/[tab]`, `training/[tab]`, `attendance/[tab]` | **DELETE** | Every tab they accept is shadowed by a static route, so they are unreachable dead code |

**Proofs 1–3, 5, 6 hold now.** Proof 4 is trivially satisfied: the table does
not exist, so there is no data. This cluster can be removed as soon as Phase 13
provides the replacement reports.

> `module-config.ts` is also the only place in either repository where
> "inventory", "payroll", "equipment" and "member analytics" appear. Deleting it
> removes the last trace of the missing GMS modules — which is correct: they
> should exist as real modules or not at all, not as copy for a screen that
> returns 503.

---

## 2. Abandoned person and membership tables

| Item | Class | Evidence | Blocked on |
|---|---|---|---|
| `members` (legacy) | **REPLACE** | 0 rows, 0 orgs, no `organization_id`, endpoint deleted. `MEMBERS-TENANT-GAP.md` | Phase 2 rebuilds it (see architecture §2.2) |
| `member_memberships` | **REPLACE** | Empty; FK to `members`; read only by `renewal.worker.js` and `bookings.service.js` | Phase 3 |
| `clients` (legacy) | **DELETE** | 0 rows. `clients.legacy-table.test.js` already fails the build if anything reads it | Phase 14 — `pt_commissions.client_id` and `session_balance.client_id` still name it as an FK target |
| `subscriptions`, `renewals` | **DELETED** | Already dropped by `021_remove_members_feature.sql` | — |
| `holds_freezes` | **DELETE** | Orphaned — its FK to `subscriptions` was dropped by 021. Superseded by `membership_freezes` | Phase 3 |
| `membership_actions`, `churn_risk_log`, `trials`, `trial_sessions` | **DELETE** | No route, no worker, no frontend reference | production count |
| `staff`, `staff_targets` | **DELETED** | Dropped by `064_drop_staff_module.sql`, both verified empty | — |
| `staff_new`, `staff_targets_new` | **DELETE** | Created by `033_schema_fixes.sql`; never read by any route or worker | production count |

**`members` is the one to be careful with.** It is empty, but
`member_memberships` has a live foreign key to it and `renewal.worker.js` joins
it — and `membersEndpointRemoved.test.js` asserts that join still exists, so
dropping the table naively breaks a passing test that exists for a good reason.
Order: Phase 3 retargets the worker → the FK goes → the table is rebuilt.

---

## 3. Duplicated entities

Per the brief: identify, do not auto-merge.

| Group | Canonical | Legacy | Migration | Deletion safety |
|---|---|---|---|---|
| person | **`members`** (new, Phase 2) | `clients` (0 rows), `members` (0 rows), `pt_clients` (live) | `pt_clients` gains `member_id`; **kept**, becomes the PT enrollment profile | `clients` after Phase 14; `pt_clients` **never** |
| trainer | **`staff` + `trainer_profiles`** (Phase 8) | `trainers` (6 rows, live), `pt_trainers` (**0 rows, never written**) | `trainers` → `staff`; `pt_trainers` retired | `pt_trainers` is safe now — 145 verified 0 rows and `POST /trainers` writes to `trainers` by design |
| plan | **`membership_plans`** (Phase 3) + **`pt_packages`** (PT) | `plans` (untenanted, V-03), `pt_plans` (untenanted, global `UNIQUE(name)`, V-15) | `plans WHERE kind='Membership'` → `membership_plans`; `plans WHERE kind='PT'` and `pt_plans` → `pt_packages` | after the UPI checkout path is repointed — `upi-payments.js:359` reads `plans` live |
| payment | **`payments` + `orders`** (Phase 5) | `payments` (legacy, empty), `pt_payments` (live), `membership_payments` (live) | both live tables gain nullable `order_id`; neither is moved | legacy `payments` after Phase 5 |
| leave | **`leave_requests`** | `leaves` | none — `leaves` is unreferenced | production count |
| attendance | **`attendance_logs`** | `attendance` (schema.sql), `biometric_attendance`, `face_checkin_logs`, `face_descriptors` | none | `032_unify_attendance.sql` already consolidated; the rest are residue |
| webauthn | **`user_webauthn_credentials`** | `webauthn_credentials` | superseded by migration 045 | production count |

---

## 4. Workers pointed at abandoned tables

| Item | Class | Evidence |
|---|---|---|
| `renewal.worker.js` — membership expiry + auto-renew | **MIGRATE** | Tenant handling is **correct and should be preserved verbatim** (`runWithTenantContext` per org plus explicit `organization_id` filters). It reads `members`, `member_memberships`, `plans` — all abandoned — so it is functionally dead. Phase 3 repoints it at `memberships`; the tenancy code is not touched |
| `renewal.worker.js` — class reminders | **MIGRATE** | Reads `class_sessions` / `class_templates` / `bookings`, all unscoped (V-10). Phase 12 |
| `bookings.service.js` | **REPLACE** | Targets `members` / `member_memberships`. Phase 12 rebuilds on `members` |

**Consequence worth stating plainly:** no worker currently sends membership or
PT expiry reminders against live data. Notifications infrastructure is sound;
its subscribers point at empty tables.

---

## 5. Shadowed and superseded routes

| Item | Class | Evidence |
|---|---|---|
| `/api/v1/members`, `/api/v1/reports`, `/api/v1/pt-sessions`, `routes/client-actions.js` | **DELETED** | Already removed; guarded by tests. Documented in `server.js` |
| `/api/plans` | **REPLACE** | V-03. Superseded by `/api/membership-plans` (Phase 3) |
| `/api/automation/pt-packages` | **MIGRATE** | V-04. Moves under `/api/pt-os/packages`, tenant-scoped |
| `/api/classes/sessions` | **REPLACE** | V-10. Read-only stub, unscoped, no management surface |
| `/api/bookings` + `/api/v1/bookings` | **REPLACE** | Phase 12 |
| `/api/clients` | **DEPRECATE** | Thin wrapper over `pt_clients`; superseded by `/api/members` + `/api/pt-os/enrollments` |
| ~~`/api/settings/branches`~~ | **REPLACED — done (Phase 2a)** | Now serves the real `branches` table, org-scoped, with soft delete |
| ~~`branches` table (orphaned)~~ | **ADOPTED — done (Phase 2a)** | Migration 167 gave it `organization_id`, `deleted_at` and a tenant-scoped unique name, and `routes/settings.js` now reads and writes it. The `branch_*` keys were migrated out of `system_settings`, attributed by their creator via `updated_by → users.organization_id`. The table was the right shape all along; it was simply never used |

---

## 6. Data-type debt (Phase 20)

| Item | Class | Evidence |
|---|---|---|
| ~~`pt_clients.dob`, `.joining_date`, `.pt_start_date`, `.pt_end_date`~~ | **KEEP — already done** | **Correction (Phase 2).** Listed here as TEXT needing conversion. They are already `DATE`: `033_schema_fixes.sql` converted them with `ALTER COLUMN dob TYPE DATE USING NULLIF(TRIM(dob), '')::DATE`. Verified against Postgres 16 with the full chain applied. What misled the original reading is leftover defensive casting in application code (`NULLIF(pt_end_date,'')::DATE` in `pt-os.service.js`), which is now redundant — that string handling is the debt, not the columns. **Phase 20 is smaller than stated** |
| `pt_plans.name UNIQUE` | **MIGRATE** | V-15 — global uniqueness on a tenant table |
| `trainer_name` / `client_name` / `plan_name` copies | **KEEP for now** | Denormalised across `pt_clients`, `pt_commissions`, `pt_payouts`, `pt_client_renewals`. Real debt, but rename-propagation is a product decision. Revisit after Phase 14 |
| `pt_client_subscriptions.id` INTEGER vs TEXT elsewhere | **MIGRATE** | Called out as the outlier in `119_pt_leads.sql`'s own header |

---

## 6b. Superseded flag table (found in Phase 2a)

| Item | Class | Evidence |
|---|---|---|
| `feature_flags` table | **DEPRECATE** | The pre-multi-tenant flag table, replaced by migration 123's `platform_features` + `organization_features` + `plan_features`, which is what `gate()` in `server.js` and the Control Centre actually use. No `organization_id`, so an admin toggling a flag toggles it for every studio — recorded as **V-17** |
| `GET`/`PUT /api/settings/feature-flags` | **DEPRECATE** | **No caller.** `settings.getFeatureFlags` and `settings.updateFeatureFlags` are defined in the frontend api barrel and invoked from nowhere — the same shape as the dead `member.get` / `member.metrics` that preceded the removal of `/api/v1/members` |

Deliberately **not** tenant-scoped in Phase 2a: adding `organization_id` to a
table that has already been replaced would be building on the thing being
retired. Removal or migration onto the feature manager are the real options, and
both need their own production evidence — so this is recorded as a decision
rather than folded into the settings change.

## 7. KEEP — explicitly not legacy

Listed so a later reader does not mistake age for deadness. These are load-bearing:

Razorpay webhook + `gateway_transactions` idempotency · manual UPI/UTR flow ·
`invoices` + `invoice_items` + receipt numbering · `lib/features.js` and the
feature manager · the super-admin Control Centre and Command Centre ·
subscription/SaaS billing incl. coupons and proration · `attendance_logs` and
the QR check-in surface · the shared 890-row exercise library and its satellite
tables · every `pt_*` assessment, screening, programming and progress table ·
`lib/tenant-db.js`, `lib/orgGuard.js`, `db/platformPool.js` · every existing
test, including the ones that constrain this work
(`membersEndpointRemoved`, `clients.legacy-table`, `borrowedClientScope`,
`tenantScope.convention`, `rls.convention`).

---

## 8. Deletion order

Nothing in group A blocks on product work; everything else waits for its
replacement to exist and be in use.

**A — safe once a production count confirms zero rows** (no route, worker,
frontend or migration dependency in the repository):
`staff_new`, `staff_targets_new`, `leaves`, `trials`, `trial_sessions`,
`membership_actions`, `churn_risk_log`, `webauthn_credentials`,
`biometric_attendance`, `holds_freezes`

**B — after their replacement ships:**
generic module system (after Phase 13) · `plans` (after the UPI path is
repointed) · `clients` (after Phase 14) · `members` + `member_memberships`
(rebuilt in Phases 2–3) · `pt_trainers` (Phase 8) · legacy `payments` (Phase 5)

**C — never:** anything under `pt_*` that holds data. The PT suite is the
product's strongest asset. It is being repositioned, not retired.
