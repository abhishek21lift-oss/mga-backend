# GMS_MIGRATION_SCORECARD.md

Progress of the PT-first → GMS-core transformation.

**Scores move only on verified implementation evidence** — a merged migration, a
route with a tenant test, a passing suite. Not on a plan, not on a document, not
on a screen that renders. Every "Current" cell below cites what moved it.

Last updated: after Phase 0 (tenant security) and Phase 1 (target architecture).

---

## Scores

| Domain | Before | **Current** | Target | Status |
|---|---:|---:|---:|---|
| Members | 0 | **0** | 100 | 🔴 Not started — Phase 2 |
| Memberships | 0 | **0** | 100 | 🔴 Not started — Phase 3 |
| Attendance | 70 | **70** | 100 | 🟡 Works, PT-bound. Phase 4 is cheaper than planned (see below) |
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
| **Tenant Security** | **Critical** | **🟠 High** | 100 | ⬆️ **Moved** — see below |

**No domain score has moved yet, and that is correct.** Phase 0 was security and
Phase 1 was design; neither builds a GMS domain. Recording 0s here rather than
partial credit for documents is the point of the scorecard.

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
| **V-06** | `system_settings` is one global table — studio config, **branches**, **permissions** shared across all six studios |
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

## Findings that changed the plan

Recorded because each moved a phase's cost or order.

**Attendance decoupling is cheap.** `attendance_logs` is already polymorphic
(`ref_id` + `ref_type CHECK IN ('client','trainer')`). Only the *resolution
logic* in `qr-checkin.js` binds it to `pt_clients`. Phase 4 is a widened CHECK
plus a lookup change — no table rewrite, no data migration.

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
