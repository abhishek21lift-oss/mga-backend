# Can the migration chain build an empty database? No — and this is why

Phase 7, Steps 2–3. This document records the lineage analysis so the question
does not have to be re-derived, and so the baseline decision rests on evidence
rather than on a recommendation.

It deliberately stops short of the replay-and-diff verification, which had not
been run when this was written. Nothing below is a claim about what actually
happens when you run the migrations — only about what the files say.

## The finding, in one line

Seven load-bearing tables are created by **no migration at all**. They exist
only in `src/db/schema.sql`, which the migration runner never reads.

| Table | Created by a migration? |
|---|---|
| `users` | **no** |
| `clients` | **no** |
| `payments` | **no** |
| `trainers` | **no** |
| `subscriptions` | **no** |
| `attendance` | **no** |
| `renewals` | **no** |

`migrate.js` globs `migrations/*.sql` only (see the `readdirSync` at
`src/db/migrate.js:93`). `schema.sql` sits one directory up and is never
applied by it. So against a blank database the very first file,
`001_v4_upgrade.sql`, runs `ALTER TABLE users …` with no `users` to alter.

This is not a surprise to the file itself. Its header says so:

> Safe to run on an existing v3 database.

It is an upgrade, and the chain that follows inherits that assumption.

## Lineage numbers

Walking the chain in the exact order the runner applies it
(`readdirSync().sort()`), tracking which tables are known to exist at each step:

| Measure | Value |
|---|---|
| Migration files (`*.sql`) | **169** |
| …that reference no table the chain has yet created | 135 |
| …that reference a table not yet created | **34** |
| Files containing `DO $$` blocks | 58 |
| Distinct tables created across all migrations | 141 |
| Distinct tables created by `schema.sql` | 20 |

A correction worth carrying: earlier notes said "171 migrations". The
directory holds 171 entries, two of which are markdown (`TENANT-RLS-PLAN.md`,
`MEMBERS-TENANT-GAP.md`). There are **169** SQL files.

## Not every out-of-order reference is a bug

Two of the 34 turned out to be already-known and already-fixed, and the fixes
are instructive:

- `015_missing_tables_and_constraints.sql` indexes `staff_targets`, which
  `030b`/`033` create later. It is wrapped in a `to_regclass` guard, with a
  comment explaining that reordering was rejected because both files are
  already applied in production and moving them would diverge the two
  histories — and that 033 creates its own index, so a fresh database still
  ends up correctly indexed.
- `022_security_hardening.sql` alters `webauthn_challenges`, created later by
  `026`. Same treatment, same reasoning.

So somebody has been hardening this chain for fresh-database use, one guard at
a time. That work is real and should not be undone. It also does not rescue
the chain: a guard converts "abort" into "skip", and a skipped statement
leaves the schema missing whatever it would have produced. Guards make the
chain *survivable*, not *equivalent*.

## Why static analysis cannot finish this argument

58 files contain `DO $$` blocks, and several build DDL dynamically —
`157_app_tenant_role_and_rls.sql` loops over `information_schema` and
`EXECUTE format(...)`s a policy onto every table carrying `organization_id`.
No regex over the file text can tell you what that produces; only running it
can. Treat every count above as a lower bound on the divergence, not a
measurement of it.

## What follows from this

A baseline is required (Phase 7 Step 3, option B), and it must be taken from
the schema the application actually runs against rather than reconstructed
from the chain. Reconstructing would mean writing a `000_v3_base.sql` by
inference and then auditing 169 files to find everything that assumed state it
never created — with no cheap way to know when you were done, which is exactly
what replay-and-diff exists to answer.

## How the runner tracks history

Relevant because the baseline has to fit into it (Step 6):

```
CREATE TABLE IF NOT EXISTS _migrations (
  id         SERIAL PRIMARY KEY,
  filename   TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Each file is looked up by `filename`, skipped if present, otherwise applied
inside its own `BEGIN`/`COMMIT` and recorded. Ordering is lexicographic over
the filename, so a file named `000_baseline.sql` sorts ahead of `001_…` and
runs first with no change to the runner.

Marking the 169 historical filenames as applied is only honest if the baseline
genuinely contains their effects. A dump taken from a database where all 169
have run does contain them; a hand-written baseline would not, and marking
them would be a lie the next engineer inherits.

## Status — resolved, see DATABASE-BOOTSTRAP.md

- [x] Migration lineage analysed
- [x] Runner's tracking mechanism identified
- [x] Replayed against a disposable PostgreSQL 17.10 — migrations alone apply
      0 of 169; foundation first, then migrations, applies 166 of 169
- [x] Foundation wired into the runner (`applyFoundation` in `migrate.js`)
- [x] Fresh-database bootstrap verified end to end
- [x] Re-run and existing-database safety verified
- [ ] Full 169/169 replay — blocked only on a pgvector-capable PostgreSQL 17

**The conclusion this document reached — that a synthesised baseline was
required — did not survive the experiment.** It was written from static
analysis, before a Postgres was available to test against. Running the chain
showed the foundation in `schema.sql` is sufficient and the only defect was
that nothing applied it. No `000_baseline.sql` was written, and none is
needed. The operational procedure now lives in `DATABASE-BOOTSTRAP.md`; this
file is kept for the lineage evidence, which is still accurate.
