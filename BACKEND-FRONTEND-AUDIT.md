# Backend ↔ Frontend Coverage Audit

**Date:** 2026-08-04
**Backend:** `619-erp-backend` @ `66e3061` — 573 mounted routes
**Frontend:** `619-erp-frontend` @ `542cee0` — 468 distinct API calls
**Database:** Supabase project `619-erp` (`adffjnztzrolibtuvhgc`), Postgres 17, 170 tables

Method: every `app.use()` mount in `src/server.js` was resolved to its router
(recursively through `router.use(require(...))` sub-routers) to build the full
backend route table. Every `http()` / `httpSSE()` / raw `fetch()` call in the
frontend was extracted with paren-balanced parsing so the HTTP verb is read
from the call's own options object. The two sets were matched with Express
param semantics (`/:id` matches a literal segment).

---

## 1. Frontend calls that hit no backend route

Five call sites reach an endpoint that does not exist. All five 404.

| Verb | Path | Frontend origin | Live in UI? | Status |
|---|---|---|---|---|
| `DELETE` | `/api/settings/branches/:id` | `lib/api/endpoints/studio.ts` | **Yes** | Fixed — route added |
| `GET` | `/api/finance/dues` | `components/sidebar/Sidebar.tsx` | **Yes** | Fixed — now `/api/reports/dues` |
| `GET` | `/api/admin/export-database` | `lib/api/endpoints/platform.ts` | No | Open |
| `POST` | `/api/admin/backup-database` | `lib/api/endpoints/platform.ts` | No | Open |
| `GET` | `/api/reports/members` | `lib/api/endpoints/insights.ts` | No | Open |

A sixth call, `GET /api/trainers/leave?status=pending` (also
`Sidebar.tsx`), does not appear above because it *matches* a route — see
§1.2. It has been fixed alongside the dues counter.

### 1.1 Delete Branch is a broken button

`src/routes/settings.js` registers `GET /branches`, `POST /branches` and
`PUT /branches/:id` — but no `DELETE`. The frontend calls it from a real
handler:

```ts
// src/app/settings/branches/page.tsx:47
async function deleteBranch(id: string) {
  try {
    await api.branches.delete(id);          // → DELETE /api/settings/branches/:id → 404
    setItems(p => p.filter(b => b.id !== id));
    toast.success('Branch deleted');
  } catch (err: any) {
    toast.error(err?.message || 'Failed to delete branch');
  }
}
```

The request 404s, the catch fires, the row stays. Deleting a branch is
impossible from the UI.

**Fix:** add `DELETE /branches/:id` to `src/routes/settings.js` (soft-delete,
`adminOnly`, and reject deletion of a branch that still has clients).

### 1.2 Two dead sidebar badge counters

`src/components/sidebar/Sidebar.tsx:187-188` bypasses the API client and calls
two paths that do not exist:

```ts
fetch('/api/trainers/leave?status=pending', { credentials: 'include' })
fetch('/api/finance/dues',                  { credentials: 'include' })
```

- `/api/finance/dues` — there is **no `/api/finance` mount at all** in
  `server.js`. The real route is `GET /api/reports/dues`.
- `/api/trainers/leave` — this one is worse than a 404: it *matches*
  `GET /api/trainers/:id` with `id = 'leave'`. `trainers.id` is `text`, so the
  query returns no rows and the handler answers `404 {error:'Trainer not
  found'}`. The real route is `GET /api/leave?status=pending`.

Both are wrapped in `Promise.allSettled(...).catch(() => {})`, and the count
extraction falls through to `?? 0`. So both sidebar badges silently render
**0 forever** — no error, no console warning. Pending leave requests and
outstanding dues never surface in the nav.

**Fix:** point them at `/api/leave?status=pending` and `/api/reports/dues`,
and route them through `api.leave.list()` / `api.reports.dues()` rather than
raw `fetch` so they inherit auth refresh and the org header.

### 1.3 Three declared-but-unused client methods

`admin.exportDatabase()`, `admin.backupDatabase()` and `reports.members()` are
exported from the API client but called nowhere in the app. They point at
routes the backend never implemented. Either implement them or delete the
client methods — right now they are a trap for the next person who wires a
button to them.

---

## 2. Response-shape break: PAR-Q detail

`GET /api/pt-os/parq/forms/:id` composes its response in
`src/modules/pt-os/parq.routes.js:241`:

```js
res.json({ data: {
  ...form,
  family_history:      familyRes.rows,     // array
  medical_clearances:  clearanceRes.rows,  // array, PLURAL
  consent_records:     consentRes.rows,    // array, PLURAL
  documents:           docsRes.rows,       // array
}});
```

The frontend contract declares something different:

```ts
// src/lib/api/types.ts — ParqFormDetail
family_history:     FamilyHistoryRow[];
medical_clearance:  MedicalClearance | null;   // SINGULAR
consent:            ConsentRecord | null;      // SINGULAR
documents:          ParqDocument[];
```

`medical_clearances` and `consent_records` appear **nowhere** in the frontend
codebase. So `row.medical_clearance` and `row.consent` are always `undefined`:

- `components/pt-os/parq/mappers.ts:27-28` reads both. The mapper guards with
  `mc ? {...} : fresh.medicalClearance`, so there is no crash — it silently
  falls back to a blank clearance and blank consent.
- `app/pt-os/parq/page.tsx:224` — `if (row.medical_clearance?.id)
  setClearanceId(...)` never fires.

**Impact:** opening an existing PAR-Q screening for edit shows the medical
clearance and consent sections **empty even when rows exist in the database**.
Because `clearanceId` is never set, saving again takes the create path and
writes a *duplicate* `pt_medical_clearances` row instead of updating.
TypeScript cannot catch this — the type asserts a shape the backend never
sends.

**Fix (backend, preferred):** have the route emit what the contract promises —
`medical_clearance: clearanceRes.rows[0] ?? null` and `consent:
consentRes.rows[0] ?? null`. Both queries already `ORDER BY created_at DESC`,
so `[0]` is the current record. Keep the arrays alongside if any future screen
needs history.

---

## 3. Feature flags the backend does not enforce

`platform_features` holds 17 keys and the frontend gates navigation on 15 of
them (`src/lib/nav-config.ts`). `server.js` enforces only **9** via `gate()`:

```
ai_knowledge_base  ai_suite  attendance  communication  finance
insights  integrations  packages  programs
```

Gated in the UI, wide open on the API:

| Feature key | Frontend hides | Backend gate |
|---|---|---|
| `branches` | Settings → Branches | none — `/api/settings/branches` open |
| `exercise_library` | PT-OS → Exercise Library | none (`/api/exercises` is gated on `programs`) |
| `member_portal` | Member area | none — `/api/v1/members`, `/api/member/*` open |
| `passkeys` | Passkey settings | none — `/api/auth/webauthn/*` open |
| `progress_photos` | PT-OS → Progress Photos | none — `/api/progress/*` open |
| `screening` | PT-OS → PAR-Q, assessments | none — `/api/pt-os/parq/*` open |

Turning any of these off for a studio only hides the nav item. The endpoints
stay callable by anyone who knows the URL, and by any client that keeps a
stale bundle. If these flags are meant to be commercial plan gating, six of
them currently gate nothing.

**Fix:** add the matching `...gate('<key>')` to each mount, or drop the keys
from the registry and nav if they were only ever cosmetic.

---

## 4. Backend surface the frontend never uses (109 routes)

Of 573 routes, 109 are never called. Most are legitimate; the ones worth
acting on are grouped below.

### 4.0 The v1 modules had no tenant isolation — two are now deleted

Investigating §4.1 turned up something more serious than duplication. None of
the `/api/v1` module routers carried any tenant filter:

| Module | org-scoping references | Status |
|---|---|---|
| `routes/reports.js` (live, client-facing) | **23** | correct — the benchmark |
| `modules/reports` | **0** | **deleted** |
| `modules/sessions` | **0** | **deleted** |
| `modules/members` | **0** | **removed** — see MEMBERS-TENANT-GAP.md |
| `modules/bookings` | **0** | still mounted — see below |
| `modules/notifications` | 0 | safe — scopes by `user_id` |

The clearest case:

```js
router.get('/revenue', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const where = ['p.deleted_at IS NULL'];        // …and nothing else
  //  FROM payments p LEFT JOIN trainers t ON t.id = p.trainer_id
```

Any studio's admin or manager could call `GET /api/v1/reports/revenue` and
receive every studio's revenue, grouped by trainer or plan. `/dues`,
`/retention`, `/trainer-payouts` and `/export` were the same, as were the
pt-sessions routes.

**Why it had not leaked, and why that was the danger.** These routers read the
abandoned v3 tables: `members`, `payments` and `member_memberships` are all
empty, so the endpoints returned nothing. None of those three tables even has
an `organization_id` column — the v3 model predates multi-tenancy and was
dropped in favour of the `clients` / `pt_*` tables, which are scoped. The
exposure was therefore latent, not active: the day anyone populated those
tables, five endpoints would have begun serving cross-tenant data with no code
change and nothing to notice. They could not be fixed in place without a schema
change to tables holding no data, so they were deleted.

**This reverses a documented direction.** `server.js` carried ROUTE INTEGRITY
NOTE R-03: *"New pages should use /api/v1/reports. Do not add endpoints to the
legacy router — it will be removed once all consumers are migrated."* Following
that today would have migrated live, tenant-scoped reporting onto an unscoped
implementation over empty tables. The note has been rewritten in place to
record the reversal so nobody restores the old plan.

**RESOLVED — removed.** `/api/v1/members` (the client appeared to call `GET /:id` and
`GET /:id/metrics`) authorises by role only — `ctx()` does not even carry
`organization_id` — so an admin of studio A can fetch a member of studio B by
id. It reads the empty `members` table, so it 404s today, and the member
dashboard swallows that into a permanent empty state. `/api/v1/bookings` is
likewise unscoped over a `bookings` table with no `organization_id` and 0 rows.
Both need the same call as the deleted pair: delete and migrate the two client
call sites, or add `organization_id` to those tables and scope them.

### 4.1 Three modules that are entirely dead

Mounted only under `/api/v1`, with a parallel non-v1 implementation the
frontend actually uses:

| Dead module | Mount | What the frontend uses instead |
|---|---|---|
| `modules/sessions/sessions.routes.js` | `/api/v1/pt-sessions` (5 routes) | `/api/pt-os/sessions` |
| `modules/reports/reports.routes.js` | `/api/v1/reports` (5 routes) | `/api/reports` (`routes/reports.js`) |
| ~~`modules/members/members.routes.js`~~ | ~~`/api/v1/members`~~ — **removed**, see MEMBERS-TENANT-GAP.md | `/api/clients` |

`/api/v1/members` is partially alive — the frontend calls `GET
/api/v1/members/:id` and `GET /api/v1/members/:id/metrics` only. The other
seven routes (list, create, patch, delete, freeze, attendance, payments) are
unused because client management goes through `/api/clients`.

This is two parallel implementations of the same domain. `modules/reports`
and `routes/reports.js` both answer "revenue" and "dues" with different SQL
and different shapes — whichever one a future screen picks will disagree with
the other.

**Recommendation:** pick one implementation per domain and delete the other.
If `/api/v1/*` is the intended direction, migrate the frontend; if not, remove
the three modules. Leaving both is how the two `dues` numbers drift apart.

### 4.2 Six overlapping client-renewal endpoints — RESOLVED

All six are gone, along with the rest of `routes/client-actions.js` (thirteen
endpoints) and its mount. The frontend renews exclusively through
`POST /api/pt-os/clients/:id/renew`, which is org-scoped.

Two things found while removing them, neither visible from the route list:

* Every one of them read and wrote the legacy `clients` table, which has **no
  `organization_id` column**. Nothing on that mount could be tenant-scoped —
  not "was missing a filter", but had nothing to filter on — while sitting
  behind plain `auth`. The table has held 0 rows since PT-OS enrolment shipped,
  so every handler 404'd before its UPDATE; the safety came from the data, not
  the code.
* Four of them `INSERT INTO renewals` or `subscriptions`. **Neither table
  exists** in this database. They would have 500'd had the 404 not stopped them
  first.

`src/__tests__/clients.legacy-table.test.js` now fails if anything mounted at
`/api/clients` reads that table again.

### 4.3 Built but never surfaced

Working endpoints with no UI:

- `GET /api/attendance/stats`, `/api/attendance/gaps`,
  `/api/attendance/today-summary`, `POST /api/attendance/bulk`
- `GET /api/clients/:id/attendance`, `GET /api/clients/:id/payments`
- `GET /api/reports/trainers`
- `GET /api/settings/studio`
- `GET /api/payments/upi/:id/receipt`
- `GET /api/super-admin/billing/invoices/:id/pdf`,
  `GET /api/super-admin/billing/invoices/export`,
  `GET /api/super-admin/audit/export`
- `GET /api/super-admin/mail/status`, `POST /api/super-admin/mail/test`
- `POST /api/pt-os/payouts`, `POST /api/pt-os/payouts/:id/approve`,
  `POST /api/pt-os/trainers`, `PUT /api/pt-os/clients/:id/notes`
- `POST /api/offers/:id/redeem`, `POST /api/feedback`
- `POST /api/plans`, `PUT /api/plans/:id`, `DELETE /api/plans/:id`
- `DELETE /api/profile/devices/:id`, `DELETE /api/profile/sessions/:id`

The super-admin export/PDF endpoints are the notable ones — invoice PDF and
CSV export exist server-side but there is no button anywhere.

### 4.4 Correctly unused (no action)

45 `/api/v1/auth/*` and `/api/v1/bookings/*` routes are deliberate
dual-mounted aliases of the `/api/*` routes the frontend already calls;
3 `/uploads/*` static handlers; `POST /api/webhooks/razorpay`,
`GET /api/calendar/callback`, `GET /api/invitations/track/:trackId.gif`
(external callers); `GET /api/public/*`; `POST /api/debug/email-queue`;
and the four `POST /api/admin/*` reset operations (deliberately not wired to
any button).

---

## 5. Contract drift that is currently harmless

Optional fields declared in `src/lib/api/types.ts` that the backend never
emits. Nothing reads them today, so these are latent rather than broken:

| Type | Field | Reality |
|---|---|---|
| `MedicalClearance` | `form_id?` | column is `parq_form_id` |
| `ConsentRecord` | `form_id?` | column is `parq_form_id` |
| `ParqDocument` | `form_id?` | column is `parq_form_id` |
| `ParqDocument` | `uploaded_at?` | column is `created_at` |

Rename these in the frontend types to match the schema before something starts
reading them.

**Not a defect:** `ParqCurrentHealth`, `ParqPastHistory` and `ParqTrainerNotes`
declare ~48 fields that appear nowhere in the backend. These are stored as
`jsonb` and validated as `z.record(z.string(), z.unknown())`
(`parq.routes.js:160-163`), so the backend is a deliberate pass-through. Worth
knowing that no server-side validation exists on those blobs.

---

## 6. Database findings

`pt_parq_forms`, `pt_medical_clearances`, `pt_consent_records` and
`pt_parq_documents` all confirmed: the FK column is `parq_form_id` in every
case (see §5).

**RLS disabled on two tables — lower severity than first reported.** `staff`
and `staff_targets` are the only two public tables with Row Level Security
off. The first version of this document repeated the Supabase advisor's
wording — "fully exposed to anon and authenticated, anyone with the anon key
can read or modify every row" — and that is **not accurate for this project**.
Two checks against the live database corrected it:

- Neither table grants anything to `anon` or `authenticated`. Only 14 objects
  in `public` do, and these are not among them. Without a GRANT, PostgREST
  cannot reach them whatever RLS says.
- Both tables are empty.

So there is no exposure today. It is still worth closing, because the only
thing protecting these two is the *absence of a grant* — a future
`GRANT ... ON ALL TABLES IN SCHEMA public`, or a Supabase default-privilege
change, would quietly make them readable while the other 168 stayed protected
by their policies.

The fix is also not what this document first suggested. There are **no
`organization_id`-scoped policies anywhere in this database** — all 241
policies are deny-all (`USING false WITH CHECK false`). That is deliberate:
the API connects as the table owner and bypasses RLS, so tenant isolation is
enforced in application SQL via `tenantScope()`, and RLS exists only to make
the anon/authenticated keys inert. A tenant-scoped policy here would be the
outlier. Migration `148_staff_tables_rls.sql` follows the house pattern
(deny-all + `REVOKE`), matching `130_admin_invitations.sql`.

That migration is **written but deliberately not applied** to the Supabase
project — applying DDL to the live database is the operator's call. It was
verified against a throwaway local Postgres 16 instead: it applies cleanly, is
idempotent on a second run, and — with grants deliberately restored to simulate
the future blanket-`GRANT` scenario it defends against — `anon` reads 0 rows
and its `INSERT` is rejected by the policy, while the owner connection the API
uses still sees everything. Run it through the normal `npm run migrate` path.

**The 14 anon-granted objects are safe, and worth recording as checked.** All
14 are views (`v_clients`, `v_outstanding_dues`, `v_pt_balance_sheet`,
`v_trainer_monthly_earnings`, …) and all have RLS off with no policies, which
looks alarming in isolation. They are fine: every one of them is
`security_invoker = true`, so a view runs with the *querying* role's
privileges and the deny-all RLS on the underlying base tables applies. Had any
been left at the default (`security_invoker` off), it would have run as its
`postgres` owner and handed anon a cross-tenant read of every studio's client
list and revenue. Worth not regressing — a new view added without
`security_invoker = true` would be a genuine breach.

---

## Priority

| # | Item | Status |
|---|---|---|
| 1 | **PAR-Q `medical_clearance` / `consent` shape** (§2) — silent data loss plus duplicate-row writes on every re-save | **Fixed** |
| 2 | **Sidebar badge paths** (§1.2) — two nav counters permanently zero | **Fixed** |
| 3 | **`DELETE /api/settings/branches/:id`** (§1.1) — visibly broken button | **Fixed** |
| 4 | **RLS on `staff` / `staff_targets`** (§6) — hygiene, not exposure (see §6) | Migration `148` written, **not applied** |
| 5 | Dead client methods (§1.3) and PAR-Q type drift (§5) | **Fixed** |
| 6 | **Six unenforced feature gates** (§3) | Open — **product decision, by design** |
| 7 | **Unscoped v1 modules** (§4.0) — cross-tenant reads, latent | `reports` + `sessions` **deleted**; `members` + `bookings` open |
| 8 | Renewal endpoint sprawl (§4.2) | Open — cleanup |

**On §3, this document was wrong to call it a gap.** `requireFeature` in
`src/lib/features.js` carries an explicit note from its author: *"Express
guard. Deliberately NOT applied to any existing route. Wiring an existing Admin
Studio route to a flag changes that studio's behaviour, which is a product
decision, not a side effect of building the control plane."* The nine gates
that exist are nine decisions someone made; the six that do not are six
decisions not yet made. That is a staging choice, not an oversight.

Adding them would be safe *today* — every feature currently resolves to on for
every studio (0 rows in `organization_features`, 0 with `default_enabled` or
`global_enabled` false, 0 disabled `plan_features`, across 5 organizations), so
the six gates would be a behavioural no-op until someone toggles a flag. But
"safe today" is not the same as "correct", and which of the six should become
gateable is a commercial question.

§4.1 turns on whether `/api/v1/*` is the intended direction or a stalled
migration. NOTE SUPERSEDED: `/api/v1/members` was deleted — the frontend calls
`GET /:id` and `GET /:id/metrics` from it — so that one needs a migration of
those two call sites first, while `modules/sessions` and `modules/reports` have
zero callers and could go today.

### Found while fixing, not yet addressed

**Branches are platform-global in a multi-tenant product.** `system_settings`,
where branches live as `branch_<uuid>` keys, has **no `organization_id`
column** — so the branch list is shared across every studio on the platform.
`GET/POST/PUT /api/settings/branches` are all unscoped, and the new `DELETE`
matches them rather than inventing scoping the table cannot express. If more
than one studio is live, they are seeing and editing each other's branches.
That is a schema change (`organization_id` on `system_settings`, backfill, then
scoping all four routes), not a route patch.

**Post-fix cleanup: not needed after all.** An earlier draft flagged that forms
saved under the old behaviour would carry duplicate `pt_medical_clearances`
rows and suggested a dedupe migration. Checked against the live database:
`pt_medical_clearances` holds **0 rows**, and `pt_consent_records` holds 4 rows
across 4 distinct `parq_form_id`s — **no duplicates anywhere**. The duplicate
path needed an existing clearance to be reopened and re-saved, and with no
clearance ever created it was never taken. The defect was real and the fix
stands; it simply had not corrupted anything yet. No migration required.
