# GMS_MIGRATION_SCORECARD.md

Progress of the PT-first → GMS-core transformation.

**Scores move only on verified implementation evidence** — a merged migration, a
route with a tenant test, a passing suite. Not on a plan, not on a document, not
on a screen that renders. Every "Current" cell below cites what moved it.

Last updated: after Phase 4 (member check-in, front desk).

---

## Scores

| Domain | Before | **Current** | Target | Status |
|---|---:|---:|---:|---|
| Members | 0 | **70** | 100 | 🟢 ⬆️ **Moved twice** — end-to-end and tenant-tested. A gym owner can now register a member without touching PT |
| Memberships | 0 | **72** | 100 | 🟢 ⬆️ **Moved twice** — a studio can sell, renew, freeze and cancel one end-to-end |
| Attendance | 70 | **82** | 100 | 🟢 ⬆️ **Moved** — a gym member can check in, and the desk sees their membership in the same response |
| Billing | 60 | **60** | 100 | 🟡 Payment rails strong; no order layer |
| POS | 0 | **0** | 100 | 🔴 Not started — Phase 6 |
| Inventory | 0 | **0** | 100 | 🔴 Not started — Phase 7 |
| Expenses | 30 | **30** | 100 | 🟡 API real and tenant-safe; zero UI |
| Staff | 0 | **0** | 100 | 🔴 Module dropped by migration 064 — Phase 8 |
| CRM | 30 | **30** | 100 | 🟡 `pt_leads` real and scoped, but PT-only |
| Lockers | 0 | **0** | 100 | 🔴 Zero occurrences of "locker" in either repo |
| Classes | 10 | **10** | 100 | 🔴 Read-only stub, unscoped (V-10) |
| Reports | 40 | **40** | 100 | 🟡 Real reports exist; 9 "All Reports" tabs are 503s |
| PT OS | 78 | **78** | 100 | 🟢 Strongest area. Repositioning, not rebuilding |
| **Tenant Security** | **Critical** | **🟠 High** | 100 | ⬆️ **Moved twice** — V-06 closed in Phase 2a; 10 findings remain |

---

## Members — 0 → 45 (Phase 2) → 70 (Phase 2b)

**Why 70 and not higher.** The domain is genuinely end-to-end: a gym owner can
register a member, find them, edit them and remove them, with no PT screen
involved. What is missing is everything that hangs off a member and does not
exist yet — a member has no membership, no attendance of their own, no payment
history and no locker, because those are Phases 3–10. Members also does not
appear in any report. The rubric reserves 91+ for a domain that is reported on
and RLS-backstopped, and V-16 is still open.

Evidence — backend (Phase 2):

| Change | Detail |
|---|---|
| Migration 166 | Canonical `members`, org-scoped `NOT NULL` from birth, RLS deny-all, tenant-scoped unique indexes |
| Legacy table | Abandoned v3 `members` **renamed** to `legacy_members_v3`, not dropped — the `membersEndpointRemoved` guard keeps its full force |
| `pt_clients.member_id` | Added `ON DELETE RESTRICT`; every PT client backfilled to exactly one member |
| `/api/members` | List, get, create, update, soft-delete. Every query carries the organization predicate |
| V-11 | Notification broadcast now resolves recipients inside the caller's organization |
| Tests | 27 new, incl. the five-step IDOR matrix per verb and the three member-code defects |

Evidence — frontend (Phase 2b), in `mga-frontend`:

| Change | Detail |
|---|---|
| `/members` | Roster with server-side search and status filter, and a create dialog |
| `/members/[id]` | Detail and edit, listing PT enrollments and linking out to the PT module rather than reimplementing it |
| `api.members` | Five endpoints; api-shape snapshot updated with six purely additive lines |
| Navigation | A **Members** group, placed above the PT client group and carrying no feature tag |
| Tests | 11 new, pinning the domain distinction rather than the markup |

Frontend: 1317 passing, typecheck clean, 0 lint errors, production build green.

**The "no PT" state is the assertion worth knowing about.** A member with no
personal training renders one plain sentence — not an EmptyState, not a call to
action. Someone tidying that page could reasonably "improve" it into an empty
state that wants filling, which silently restores the framing where PT is the
default and its absence is a gap. A test fails if an `EmptyState` appears in
that section.

**Nothing else was added to the navigation.** Memberships, POS, Inventory, Staff
and Lockers stay absent until their modules exist.

**Verified against a real Postgres 16**, not by inspection: the full 185-migration
chain was applied to an empty database, then re-run with seeded multi-studio data.
That is what caught the three defects below.

### What running it actually caught

Each of these passes a source review and an empty-database run, and fails on
real data:

1. **`date ~ unknown` has no operator.** The backfill guarded `dob` and
   `joining_date` with a `^\d{4}-\d{2}-\d{2}$` regex, on the belief they were
   TEXT. They are `DATE` — `033_schema_fixes.sql` converted them long ago. The
   migration survived a fresh-install run only because `pt_clients` was empty, so
   PL/pgSQL never planned the loop body. **The first real row would have taken
   the deploy down.**
2. **Member codes numbered from 1, not MAX + 1.** Exactly the defect
   `MEMBERS-TENANT-GAP.md` records about the deleted generator. Caught by seeding
   a pre-existing member and re-running: the backfill collided with `M00001` on
   `uq_members_org_code`.
3. **`pg_advisory_xact_lock(bigint, integer)` does not exist.** Only `(bigint)`
   and `(integer, integer)`. The namespace had to move into the hash seed. This
   would have raised 42883 on the first member ever created.

### Phase 2a — V-06 closed

`system_settings` was one global key/value table: all six studios shared one
studio name, address, currency, timezone, check-in and geofence config, one set
of role permissions, and one list of branches. `GET /api/settings` returned the
platform's whole configuration to any authenticated user, and `DELETE
/branches/:id` deleted somebody else's branch.

Migration 167 adds `organization_settings` keyed `(organization_id, key)` and
gives `branches` an `organization_id`, adopting the table that had sat orphaned
since `schema.sql`. `routes/settings.js` is rewritten against both.

**Neither half needed a production count**, and the reason is the distinction
worth carrying into the remaining sixteen tables:

- Configuration keys were shared **by design** — every studio already read the
  same `currency` row — so giving each studio a copy of that value is exactly
  behaviour-preserving. Verified on a seeded two-studio database, including that
  a studio's own later edit survives a re-run.
- Branches were the opposite, and carried their owner: `POST /branches` has
  always stamped `updated_by`, so the creating admin's organization owns the
  branch. In the test fixture two branches attributed correctly to two different
  studios and a third with no creator was **reported, not guessed**.

`system_settings` rows are left in place and simply no longer read, so this
reverses by reverting code rather than restoring data.

Two existing test files pinned behaviour that deliberately changed and were
retargeted rather than relaxed. `settings.branchDelete.test.js` asserted a 409
when a branch still had members — that count came `FROM clients`, the legacy
table with 0 rows, so it could never fire; the delete is now soft, which removes
the dangling-reference risk the 409 existed to prevent rather than merely
dropping the check. The member-count guard returns against `members` when the
member domain gains branch assignment.

**V-17, new:** `feature_flags` is also global, and deliberately left that way.
It is the pre-multi-tenant flag table superseded by migration 123's feature
manager, and both its endpoints have no caller. Tenanting a replaced table would
be building on the thing being retired — classified DEPRECATE instead.

### Phase 3 — the membership domain

Migration 168 adds `membership_plans`, `memberships`, `membership_freezes` and
`membership_events`, all org-scoped `NOT NULL` from birth with tenant-scoped
uniques. `/api/membership-plans` and `/api/memberships` carry the lifecycle:
sell, renew, freeze, resume, change plan, cancel. 39 new tests.

**A gym membership is not a PT package**, which is why these are separate tables
rather than a `kind` column: one grants building access and is consumed by time
passing, the other grants sessions with a trainer and is consumed by a session
being delivered. `pt_packages` is untouched.

**`plans` is deliberately NOT migrated.** Phase 2a could fan `system_settings`
out without a production count because those values were shared *by design*.
`plans` is the opposite case — each row was created by one studio and nothing
records which — so copying "Gold Annual, ₹25,000" into all six catalogues would
preserve today's broken behaviour while making the leak permanent. The catalogue
starts empty and each studio writes its own. V-03 is untouched and still gated on
its count.

**What the tests pin is arithmetic, not just tenancy.** A membership is dates and
money, and each of these is wrong in a way that throws nothing:

- a 30-day plan starting on the 1st ending on the 31st — twelve free days a year;
- a renewal back-dated onto a lapsed term, selling days already gone;
- a joining fee charged again on renewal;
- a freeze closing without extending the term, so the member loses paid days;
- a total taken from the request instead of computed, letting a caller set their
  own price.

### Phase 3b — the UI (0 → 55 → 72)

Three surfaces in `mga-frontend`: a membership panel on the member's own page, an
expiring-soon list, and the plan catalogue. 17 new tests, 1334 passing, build
green.

| Claim pinned by test | Why it needs pinning |
|---|---|
| Selling happens on the member page, not the list | You sell a membership *to someone*. From a list you would pick a member out of a dropdown first, which is backwards from a front desk |
| The membership panel renders **above** personal training | A gym membership is what most members have; PT is the optional extra. Swapping them restores the PT-first framing |
| The two empty states differ | PT's is understated — no trainer is a complete record. Membership's offers the plans — no membership means nothing has been sold |
| The list opens on expiring-in-7-days | The question a front desk asks each morning. A full list buries it under last month's renewals |
| The catalogue seeds nothing | Copying legacy `plans` rows would present another studio's pricing as this one's; inventing Basic/Premium/Gold is fabricated product data |
| Current membership = latest `ends_on` | Renewing before expiry is normal, so a member can hold two non-expired memberships. `rows[0]` would show whichever the database returned |
| Resume reports the days added back | The extension is the point of a freeze; leaving it to be spotted on the end date is how members end up arguing about lost days |

**Why 72 and not higher:** no payment linkage yet — selling records
`amount_paid` but does not create an invoice or a gateway payment, which is
Phase 5's order layer; memberships do not appear in any report (Phase 13); and
attendance did not check a membership — closed in Phase 4. 91+ also needs V-16.

### Notifications — reminders now actually fire

`renewal.worker.js`'s expiry reminders are rewritten against the new domain, and
a new nightly sweep marks lapsed memberships expired — ordered before the
reminders, so a membership that ended weeks ago stops sitting in the active set.

**Auto-renew is left disabled, explicitly.** The `memberships` table has no
`auto_renew` flag because giving it one is a product decision, not a refactor:
charging a stored card needs a mandate this product does not collect, and every
payment path that works today is member-initiated. It now logs why instead of
raising an exception that gets swallowed. The Razorpay order/capture handling and
the `gateway_transactions` producer are kept for Phase 5.

Class reminders are still broken (V-10) and belong to Phase 12.

### Also found, and it changes Phase 3

**`renewal.worker.js` had never run.** *(Fixed in Phase 3 — see above.)* Not
"reads empty tables" — its SQL was
invalid against the schema. `member_memberships` has no `plan_id`; the legacy
members table has neither `name` nor `deleted_at`; all three are selected or
filtered on. Every statement raises at plan time, for every organization, on
every scheduled run, and `forEachOrganization`'s per-organization error handling
swallows it.

So **no membership expiry reminder, renewal reminder or auto-renewal has ever
been sent.** Phase 3 is a rewrite of those queries, not a repointing of table
names. Its tenant handling — `runWithTenantContext` plus an explicit
`organization_id` filter per query — is correct and stays.

---

## Tenant Security — the only score that moved

**Critical → High.** Evidence, all merged:

| Change | Commit |
|---|---|
| `TENANT_SECURITY_AUDIT.md` — 144 tables classified, 16 findings, remediation + tests | `b8a197e` |
| Migration 165 — `organization_id` + index + backfill on 5 tables | `c57cd4a` |
| V-01/V-02 lifestyle + nutrition assessments scoped (GET/POST/PATCH) | `c57cd4a` |
| V-09 leave requests scoped (list, get, create, overlap, approve, reject) | `c57cd4a` |
| V-05 (partial) `mark-all-paid` bounded to one organization | `c57cd4a` |
| `routes/leave.js` removed from the convention guard's exemption list | `c57cd4a` |
| 44 new tests — static shape + runtime placeholder alignment | `c57cd4a` |

Suite: **1888 passing**, lint clean. The single failure
(`testEnv.isolation.test.js`) is environmental — this sandbox's proxy injects a
placeholder credential the test correctly refuses to accept — and predates the
change. Not modified.

### Why it is not yet Medium, and nowhere near 100

Open, and each is a live cross-tenant path with real callers:

| Finding | Surface |
|---|---|
| **V-03** | `/api/plans` — read, update and soft-delete any studio's membership plans |
| **V-04** | `/api/automation/pt-packages` — incl. a hard `DELETE` |
| **V-07** | `/api/offers`, `/api/campaigns`, `/api/feedback` (member PII) |
| **V-08** | `/api/integrations` |
| **V-10** | `/api/classes`, `/api/bookings` |
| **V-11** | notification broadcast accepts a foreign `member_id` — **must be fixed before Phase 2** |
| **V-16** | no database backstop: API connects as `postgres` (`rolbypassrls`), 0 org-scoped RLS policies, `TENANT_RLS_ENFORCE` off |

**All sixteen remaining tables are blocked on the same thing:** they carry no
foreign key identifying an owner, so the backfill needs a read-only production
count before it can be written. `TENANT_SECURITY_AUDIT.md` §5 specifies the
query and the three outcomes. Guessing an owner would hand one studio's data to
another permanently and silently — the exact failure being fixed.

100 requires V-16: RLS enforced with the `app_tenant` role, per
`db/migrations/TENANT-RLS-PLAN.md`. Until then every score in this table rests
on hand-written predicates with no backstop.

---

## Attendance — 70 → 82 (Phase 4)

**Why 82 and not higher.** A member can now check in, be checked out, and be
counted — end to end, with the front desk seeing their membership in the same
response. What is missing keeps it under 91: members have no self-service
check-in (the QR path still resolves through `pt_clients`), member attendance
appears in no report, and the rubric reserves 91+ for a domain that is reported
on and RLS-backstopped. V-16 is still open.

**Why the domain was stuck at 70 and not lower.** Nothing about attendance was
broken. `attendance_logs` has been tenant-scoped since 087, polymorphic since
001, and the register, stats and gaps endpoints all worked. What was PT-bound
was *who was allowed to appear in it*: the `ref_type` CHECK admitted `client`,
`trainer`, `staff` and `user` — the four kinds of person a PT studio has. In a
product whose central daily event is a member walking through the door, that
event was not recordable. Not badly recorded — `INSERT` raised a check
violation.

Evidence — backend:

| Change | Detail |
|---|---|
| Migration 169 | `'member'` added to the `ref_type` CHECK; `member_id` column; a CHECK that `member_id` and `ref_type` agree |
| **Tenant FK** | `(member_id, organization_id)` → `members(id, organization_id)`, so a cross-tenant check-in is unrepresentable rather than merely refused |
| `POST /check-in` | Returns the membership alongside the attendance row — one request, because two means the desk sees "checked in" before it sees "expired three weeks ago" |
| `POST /check-out` | Closes today's visit; separate from check-in, because a toggle guesses wrong for the member who scans twice on the way in |
| `memberInOrg` | Added to `lib/orgGuard.js` and applied on all three write paths, turning the FK's 23503 into the 404 the caller should get |
| `today-summary` | Takes `?type=`, defaulting to `client` so every existing caller keeps the number it has today |
| Tests | 18 new |

Evidence — frontend, in `mga-frontend`:

| Change | Detail |
|---|---|
| `/front-desk` | Search, check in, verdict. One screen, one job |
| `api.attendance` | `checkIn`, `checkOut`, `todaySummary`; api-shape snapshot updated with three purely additive lines |
| Navigation | **Front Desk** placed above All Members in the Members group — it is the screen that group is opened for most often |
| Tests | 12 new, pinning the verdict rather than the markup |

Frontend: 1355 passing, typecheck clean, 0 lint errors.

**The composite foreign key is the part worth reading.** Verified against a real
Postgres 16, a plain `REFERENCES members(id)` accepted studio B's member into
studio A's `organization_id`. The row never leaks on read, because every SELECT
carries the org predicate — studio A simply accumulates attendance for a person
they have never met, and studio B's member count is quietly wrong.
`routes/attendance.js` does guard this, but a guard in one file is a guard until
someone adds a fourth write path, a bulk importer, or a worker. Over the pair,
the invariant is the database's.

**Check-in records and reports; it does not refuse.** An expired membership
still returns 201, with `grants_entry: false`. Refusing would be the API
deciding a studio's admission policy, and it would be wrong at the moment it
mattered most — the member who paid cash ninety seconds ago, whose renewal is
still being keyed in, is exactly who a hard block turns away. Both the backend
test suite and the front-desk suite pin this, because "expired should be
blocked" is a very reasonable thing for someone to think they are fixing.

**A wrong claim caught before it shipped.** The first draft of migration 169
also added RLS to `attendance_logs`, on the strength of a grep that found no
migration naming the table beside a policy. That was wrong twice over: 131
applies the full house pattern to it and 157 adds `tenant_isolation`, both
discovering their tables at run time. It is the same dynamic-migration blind
spot that cost the audit a wrong count of 90 tables against a true 77. A
deny-all OR'd with `tenant_isolation` restricts nothing, while telling the next
reader the table is deny-all when it is not — so the section now records why
nothing is needed instead.

---

## Findings that changed the plan

Recorded because each moved a phase's cost or order.

**Attendance decoupling is cheap** — confirmed, and it was even cheaper than
predicted. `attendance_logs` is already polymorphic (`ref_id` + `ref_type`),
already org-scoped, already branch-aware. Phase 4 shipped as a widened CHECK
plus a foreign key: no table rewrite, no data migration, no backfill. The
prediction was right about the mechanism and slightly wrong about the blocker —
it is not `qr-checkin.js`'s resolution logic that bound attendance to PT, it is
that the `ref_type` CHECK admitted only PT-shaped people, so a member check-in
raised a constraint violation on **every** write path, not just the QR one.

**V-05 is inert, not live.** The commission/payout module resolves trainers
through `pt_trainers`, which migration 145 verified holds 0 rows and which
`POST /api/pt-os/trainers` deliberately never writes to. Every read returns
nothing; every write throws. It is **latent**: Phase 8 reconciles the
`trainers`/`pt_trainers` split, and on that day five endpoints begin serving
cross-tenant financial data with no code change. **The V-05 fix is a
prerequisite of Phase 8, not a follow-up.**

**Per-studio settings is a hidden prerequisite.** There is no per-organization
configuration store at all. Memberships, POS, lockers and notifications all need
one, so it is promoted to **Phase 2a**, immediately after the member domain.

**The convention guard has a structural blind spot.** It derives its tenant-table
list from `organization_id` presence, so a table without the column is invisible
to it. Every confirmed leak is on such a table. The fix — inverting it to an
allow-list, so a new tenant table without the column fails the build — is
specified in the audit §P0-C and **not yet implemented**.

---

## Scoring rubric

A domain scores against the ten-point end-to-end test from the original audit —
UI, API, business logic, database, validation, permissions, **tenant isolation**,
error handling, reporting, tests.

| Band | Meaning |
|---|---|
| 0 | No table, no route, no UI |
| 1–30 | Something exists but no usable workflow (e.g. an API with no UI) |
| 31–60 | Workflow exists with material gaps (no tenant test, no reporting) |
| 61–90 | End-to-end and tenant-safe; edge cases or reporting incomplete |
| 91–100 | Complete, tenant-tested, reported on, and RLS-backstopped |

A domain **cannot exceed 60 without a tenant isolation test**, and cannot reach
91 while V-16 is open. That ceiling is why Tenant Security is tracked as a row
rather than folded into the others.

---

## Acceptance criteria for "GMS core"

Not met yet. All five must hold:

1. A gym owner can register a member, sell a membership, take payment, issue a
   receipt and check that member in — **without touching any PT screen**.
2. `pt_os` can be switched off in the feature manager and the product remains a
   working gym management system. Enforced by test.
3. No core GMS table references a `pt_*` table.
4. Every tenant-owned table carries `organization_id`; every endpoint has the
   five-step IDOR test (A creates → A reads → B cannot read / update / delete).
5. No placeholder screens, seeded demo records or 503-backed navigation.
