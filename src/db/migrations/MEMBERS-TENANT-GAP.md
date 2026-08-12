# `members` has no tenant column, and RLS cannot cover it

**RESOLVED — Option 1. The `/api/v1/members` endpoint and its module were
removed. The table was left untouched.**

Found while resolving the `createMemberCode()` scope gap for BUG-003. Kept as a
record because the reasoning is what makes the removal reversible on purpose
rather than by accident, and because the table is still there.

The read-only production verification that decided it:

| Measure | Result |
|---|---|
| `members` row count | **0** |
| distinct organisations represented | 0 |
| unattributable rows | 0 |
| conflicting derivation | 0 |
| duplicate member codes | 0 |
| recent / active member data | none |

Nothing to preserve, nothing to migrate, nothing to backfill. Option 2's entire
cost was the backfill, and there was no data to back-fill.

`src/__tests__/membersEndpointRemoved.test.js` fails the build if the endpoint
comes back, so reinstating it means deleting those assertions — which is the
explicit decision this note exists to inform. If it does return, it must return
with a tenant boundary: the table still has no `organization_id`, so migration
157 still cannot cover it.

## What was found

`members` carries **no `organization_id`**. Verified against a full local
rebuild — `src/db/schema.sql` plus all 158 migrations:

```
members has organization_id:            false
members has a tenant_isolation policy:  false
tenant_isolation policies overall:      58
```

Migration `157_app_tenant_role_and_rls.sql` discovers tables dynamically:

```sql
WHERE c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
```

So `members` is not skipped by oversight — it is not eligible. Nothing that
happens to the RLS rollout will protect it, at any stage, ever. Pointing
`DATABASE_URL` at `app_tenant` changes nothing for this table.

## Why it mattered

The router was live. `src/server.js`, before the removal:

```js
app.use('/api/v1/members', require('./modules/members/members.routes'));
```

with nine routes behind `auth`. And `members.service.js`'s `list()` builds its
`WHERE` clause like this:

```js
if (role === 'trainer') push(`m.primary_trainer_id = $n`, trainerId);
if (role === 'member')  push(`m.id = $n`, memberId);
// …status, trainer_id, search, plan filters…
```

There is no branch for `admin` or `manager`. For those roles the `where` array
stays empty, `whereSql` is `''`, and the query is:

```sql
SELECT … FROM members m
LEFT JOIN v_member_active_membership v ON v.member_id = m.id
LEFT JOIN trainers t ON t.id = m.primary_trainer_id
ORDER BY m.created_at DESC
```

An admin of one studio calling `GET /api/v1/members` gets every studio's rows.
Neither the application layer nor the database constrains it.

The other routes have the same shape: `getById`, `update`, `delete`,
`/:id/payments`, `/:id/attendance`, `/:id/metrics`, `/:id/freeze` all address a
member by id with no org predicate.

This was already known, and recorded in the mount comment in `server.js` — the
sibling endpoints with the same defect were deleted, and this one was kept
because the client appeared to call two of its routes:

> `/api/v1/members` is still mounted because the client calls two of its
> routes … members has the same missing-org-column problem and needs the same
> decision.

That decision has now been taken — see the top of this note.

## What was never claimed

Whether any of this was ever exploitable depended on whether the table held
rows for more than one studio, and at the time of writing that had not been
checked — production data was out of scope for that work. It was flagged as an
assumption rather than a finding, and the read-only query that settled it was
run before anything was removed. The answer was 0 rows, so the exposure was
latent, never live.

## The options

1. **Delete the endpoint.** What was already done for its siblings. Costs
   whatever the two frontend calls are; nothing else in the app reads this
   table. Cheapest, and safe regardless of what the table contains.

2. **Add `organization_id`, backfill, and let 157 pick it up.** The column
   makes the table eligible for the existing dynamic policy with no change to
   migration 157 at all — which is the nice property of writing it dynamically.
   The work is the backfill: `members.client_id` references `clients(id)`, but
   migration 015 added that column as `TEXT NOT NULL DEFAULT ''`, and
   `members.service.js`'s `create()` never sets it — so rows created through
   this endpoint have `client_id = ''` and cannot be attributed to a studio by
   joining. Any backfill needs a rule for those, and the rule depends on the
   data.

3. **Scope it in the application layer only.** Adds an org predicate to all
   nine routes. Leaves the table outside RLS forever, which is precisely the
   "839 call sites and no backstop" position BUG-003 exists to get out of.

Option 1 unless the two frontend calls turn out to matter. Option 2 is the only
one that ends with the table inside the same guarantee as the other 58.

**Taken: Option 1.** The two frontend calls did not matter — `member.get` and
`member.metrics` are defined in the api barrel and invoked from nowhere, so the
cost was zero rather than two call sites. The production count then showed an
empty table, which removed Option 2's only argument (preserving real data).

What that leaves: the `members` TABLE is still outside RLS and still has no
`organization_id`. That is now harmless, because nothing serves it over HTTP —
`workers/renewal.worker.js` joins it and `member_memberships` has a foreign key
to it, and neither is a tenant-crossing read path. If the table is ever
repopulated or re-exposed, this note is the starting point again.

## What was fixed alongside this, and then deleted with the module

`createMemberCode()` had three defects independent of the missing column. They
were fixed first, before the production count came back and made Option 1 the
answer; the module was then removed, so the fixes went with it. Recorded because
they are the reasons this code should not be restored as it was:

- a **session-scoped** `pg_advisory_lock` on a pooled connection, released only
  by an explicit unlock in a `finally` — if that unlock failed, or the process
  died between lock and unlock, every subsequent member creation blocked
  forever on a connection nobody could identify. Now `pg_advisory_xact_lock`,
  released by COMMIT or ROLLBACK unconditionally.
- the code was generated on one pooled connection and the row inserted on
  **another**, with the lock dropped in between, so two concurrent creates
  could read the same last code and both use it. `create()` now owns one
  transaction across both.
- the code came from `COUNT(*) + 1`, which is not a sequence: delete one member
  and the next code collides with one that already exists. Now `MAX + 1` over
  the existing codes, the pattern `src/db/id-gen.js` already documents.

The lock key stayed a single global constant. It would normally be keyed per
org — `lib/subscription.js` keys its lock by `orgId` for exactly that reason —
but there was no `organization_id` to key on, and a global sequence needs a
global lock.

The rule those fixes established outlives the module:
`src/__tests__/borrowedClientScope.convention.test.js` fails the build if any
borrowed client runs outside a transaction, because that is the shape the
tenant wrapper cannot scope.
