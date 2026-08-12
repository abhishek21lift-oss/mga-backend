# Database-level tenant isolation — verified design and why it is not a migration yet

Audit finding C-2. This document exists because the fix is a project, not a
patch, and the half of it that is already settled should not have to be
rediscovered.

## What was verified against production

Run against the live `619-erp` project (`adffjnztzrolibtuvhgc`), not inferred:

| Check | Result |
|---|---|
| Role the API connects as | `postgres`, `rolbypassrls = true` |
| RLS policies in `public` | 247 |
| …that are organization-scoped | **0** |
| Live tenants | 6 studios, all with real client/payment data |
| Tables carrying `organization_id` | 55 |
| `pt_clients` / `pt_payments` / `pt_assessments` / `attendance_logs` / `trainers` rows with NULL `organization_id` | **0** |

Two conclusions follow. First, the finding is real: every existing policy is a
deny-all for the PostgREST `anon`/`authenticated` roles, which protects against
a leaked publishable key and does nothing about this API — the app's role
bypasses RLS entirely. Second, the application-layer scoping is genuinely
working today; the core business tables have no orphaned rows. The exposure is
not a known leak, it is the absence of a backstop under 839 query call sites.

## The policy design, and the trap in it

Not every NULL `organization_id` is a bug. Verified counts:

| Table | Rows | NULL org | Meaning |
|---|---|---|---|
| `exercises` | 890 | **890** | shared exercise library every studio draws from |
| `muscle_volume_landmarks` | 12 | 12 | reference data |
| `diet_templates` | 8 | 8 | shared templates |
| `login_events` | 322 | 131 | failed logins, no user identified yet |
| `users` | 8 | 1 | the platform super-admin, who has no org by design |

A naive `USING (organization_id = current_setting('app.org_id'))` applied
across the board would empty the 890-row exercise library for all six studios
simultaneously. Tenant tables and platform-global tables need different
policies:

```sql
-- Strict tenant table (pt_clients, pt_payments, attendance_logs, …)
CREATE POLICY tenant_isolation ON public.pt_clients FOR ALL TO app_tenant
  USING      (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));

-- Table with shared platform-global rows (exercises, diet_templates, …)
CREATE POLICY tenant_isolation ON public.exercises FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true)
         OR organization_id IS NULL);
```

Both shapes were prototyped against production inside a transaction that was
rolled back. Acting as Abhishek PT Studio the strict policy returned 12 of 29
`pt_clients` — exactly that studio's real count — while the shared policy still
returned all 890 exercises. The design works; nothing was left behind.

### The GUC caution

Migration `131_close_rls_gaps.sql` dropped four `current_setting()`-based
policies precisely because they were granted to `public` FOR ALL: nothing set
the GUC, so they denied by accident, and anyone who *could* set it got
everything. This design must not repeat that. The policies above are granted
**only** to a dedicated `app_tenant` role, never to `public`, `anon`, or
`authenticated`, and the existing deny-all policies stay exactly as they are.

## Why this cannot ship as a migration alone

RLS is only enforced if two further things are true, and neither is a database
change:

1. **The API must stop connecting as `postgres`.** A new `app_tenant` role
   without `BYPASSRLS` has to be created, granted table privileges, and put in
   `DATABASE_URL`. That is a deployment change, and it is one-way in the sense
   that every privilege the app relies on has to be granted explicitly or
   requests start failing.

2. **`app.org_id` must be set per request, on the connection running the
   query.** `SET LOCAL` is transaction-scoped, and the app runs 839
   `pool.query()` calls that each borrow a fresh pooled connection with no
   surrounding transaction. Supavisor in transaction mode (port 6543) makes
   session-level `SET` unusable, so the setting has to ride inside an explicit
   transaction.

Rewriting 839 call sites is not the answer. The tractable approach is
`AsyncLocalStorage`: the auth middleware puts the resolved org id into an ALS
store, and `db/pool.js` wraps `query()` to acquire a client, `BEGIN`,
`SET LOCAL app.org_id`, run, `COMMIT`. No call site changes. The costs are real
and must be measured before rollout — every read becomes a transaction, which
adds round trips, and the existing explicit-transaction paths (`pool.connect()`
in payments/invoices) need to opt out of the wrapper rather than nest.

## Rollout order

1. Land the ALS org-context plumbing behind an **off-by-default** flag, so it
   ships dark and changes nothing.
2. Create `app_tenant` + policies in a staging branch (Supabase branching), and
   run the full suite against it with the flag on.
3. Measure the added latency from per-query transactions. If it is material,
   consider scoping the wrapper to reads of tenant tables rather than all
   queries.
4. Switch staging's `DATABASE_URL` to `app_tenant`. Fix every permission error
   that surfaces — this is the step that finds what the app quietly relied on.
5. Only then, production.

## What guards the gap until then

`src/__tests__/tenantScope.convention.test.js` fails the build when a file
queries a tenant table without referencing the tenant boundary. It is coarse by
design (file-level, not per-query) so it does not cry wolf on correct code, and
it was mutation-tested: a route added with `SELECT id, name, mobile FROM
pt_clients` and no filter is caught. It derives its table list from the
migrations, so tenant tables added later are covered automatically.

That is a ratchet against new mistakes, not a backstop under existing ones.
It does not make the database safe; it makes the omission loud.
