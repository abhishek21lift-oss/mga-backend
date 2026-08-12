# Creating a database for MGA Gym OS

How a new database gets its schema, why the mechanism is shaped this way, and
what to check when it goes wrong. Companion to `BOOTSTRAP-LINEAGE.md`, which
holds the evidence behind the design.

## The shape of it

```
empty database
      ↓
foundation   src/db/schema.sql            ← applied once, marked in _migrations
      ↓
migrations   src/db/migrations/001 … 169  ← applied in filename order
      ↓
MGA schema
```

`npm run migrate` does all of it. There is no separate bootstrap command, and
no baseline file to keep in sync.

## Why `schema.sql` lives outside `migrations/`

It is the v4.0 foundation the migration chain was written on top of, not a
step in that chain. Migration `001_v4_upgrade.sql` says so in its own header —
"Safe to run on an existing v3 database" — and 42 of its statements are
`ALTER TABLE` against tables it never creates.

Keeping it outside the numbered sequence preserves that distinction. Moving it
in as `000_…` would work mechanically but would misrepresent it as one
migration among many, and would put a 611-line file into a sequence whose
other members are small deltas.

## Why migrations alone cannot build an empty database

Seven load-bearing tables — `users`, `clients`, `payments`, `trainers`,
`subscriptions`, `attendance`, `renewals` — are created by no migration. They
exist only in `schema.sql`.

Verified against PostgreSQL 17.10, not inferred:

| Path | Result |
|---|---|
| migrations only, empty database | **0 of 169**, fails at `001` with `42P01 relation "clients" does not exist` |
| foundation, then migrations | **166 of 169**; the 3 failures are pgvector-only |

The runner used to glob `migrations/*.sql` and nothing else, so `schema.sql`
was never applied by anything. Against every database that already had the v3
or v4 schema this was invisible. Against a genuinely empty one it was fatal on
the first file.

## How foundation initialisation works

`applyFoundation()` in `src/db/migrate.js`, called once after `_migrations` is
created and before the migration loop:

1. Look for the marker `foundation/schema-v4.sql` in `_migrations`. Present →
   log and return.
2. Otherwise read `src/db/schema.sql`, apply it inside one transaction, insert
   the marker, commit. Any failure rolls back and aborts the run, exactly as a
   failing migration does.

The marker deliberately contains a `/`. No basename from
`readdirSync(migrations)` ever will, so it cannot collide with a real
migration or be mistaken for one when reading the table by hand.

### It is safe on a database that already has the schema

`schema.sql` was audited construct by construct and is idempotent throughout:

| Construct | Count | Guard |
|---|---|---|
| `CREATE EXTENSION` | 3 | `IF NOT EXISTS` |
| `CREATE TABLE` | 20 | `IF NOT EXISTS` |
| `CREATE INDEX` | 34 | `IF NOT EXISTS` |
| `CREATE TYPE` | 5 | `DO $$ … EXCEPTION WHEN duplicate_object` |
| `CREATE FUNCTION` | 1 | `OR REPLACE` |
| `CREATE TRIGGER` | 1 | `IF NOT EXISTS (SELECT 1 FROM pg_trigger …)` |
| `ALTER TABLE` | 2 | `IF NOT EXISTS (SELECT 1 FROM pg_constraint …)` |
| seed `INSERT` | 4 | `ON CONFLICT DO NOTHING` ×3, `WHERE NOT EXISTS` ×1 |

There is no `DROP` and no `TRUNCATE` anywhere in the file.

Verified behaviourally as well as by reading: a database seeded with the
schema, real rows, and an edited `system_settings` value was migrated with no
marker present. The foundation ran, every row survived, and the edited setting
was not overwritten by the seed.

## Migration ordering and tracking

Unchanged from before. `readdirSync(migrations).sort()` — plain lexicographic
order over filenames, which is why they are zero-padded to three digits. Each
file runs in its own `BEGIN`/`COMMIT` and is recorded in:

```sql
_migrations (id SERIAL PK, filename TEXT UNIQUE, applied_at TIMESTAMPTZ)
```

A file already present in that table is skipped. The runner is fail-fast: the
first failure aborts the run, so everything after it stays unapplied rather
than being applied out of order.

Nothing is ever marked applied without having run. The foundation marker is
inserted in the same transaction that applies the foundation.

## Requirements

**PostgreSQL 17.** Production is 17.6; CI runs 17. Older majors are untested.

**pgvector.** Three migrations need it:

| Migration | Needs |
|---|---|
| `046_branch_scope_and_pgvector.sql` | `CREATE EXTENSION vector` |
| `116_ai_knowledge_base.sql` | `CREATE EXTENSION vector` |
| `135_fk_indexes_and_duplicate_indexes.sql` | `ai_document_chunks`, created by 116 |

Supabase provides pgvector. A stock `postgres:17` image does not — use
`pgvector/pgvector:pg17` for any environment that must complete the chain.

**Extensions** created by the foundation: `pgcrypto`, `pg_trgm`, `unaccent`.

**Roles.** 27 migrations grant to Supabase's `anon`, `authenticated` and
`service_role`. On a plain PostgreSQL these must exist or those migrations
fail with `42704 role "anon" does not exist`:

```sql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
```

Supabase creates them itself. Nothing here creates them, because inventing
Supabase's roles on a Supabase database is not this runner's business.

## Procedures

**Fresh database**

```bash
# roles + pgvector must exist first on a non-Supabase target
DATABASE_URL=postgresql://…  npm run migrate
```

**Existing database** — the same command. The foundation is skipped once the
marker is present, and is a harmless no-op the first time on a database that
predates the marker.

**Local or CI PostgreSQL without TLS** — append `?sslmode=disable`. Only that
exact value relaxes SSL; see `sslDisabledByUrl()` in `db/pool.js`.

## Future CI replay

CI runs `postgres:17` for the unit-test job. Completing the chain needs
pgvector, so a bootstrap job should use `pgvector/pgvector:pg17`, create the
three Supabase roles, run `npm run migrate`, and assert that all 169 migrations
plus the foundation are recorded in `_migrations`. That guards against a future
migration silently breaking fresh-database bootstrap — the failure mode this
whole document exists because of.

`embedded-postgres` was evaluated and rejected: the CI service container does
the same job without adding a large binary dependency to the repository.

## Known wart

`schema.sql` seeds `system_settings.gym_name = 'MY PT STUDIO'`. Every new MGA
database is therefore born with the previous product's name until an operator
changes it. It is a default that onboarding overwrites rather than anything
that leaves the platform, so it was left alone rather than changed inside a
phase scoped to bootstrap mechanics — but it should be picked up with the rest
of the branding work.
