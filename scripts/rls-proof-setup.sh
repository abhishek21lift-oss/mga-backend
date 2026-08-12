#!/usr/bin/env bash
# Stand up a throwaway PostgreSQL with the real schema, the real migrations and
# the real app_tenant role, so rls.isolation.integration.test.js has something
# to prove isolation against.
#
# This is the missing half of scripts/e2e-setup.sh: that one builds the same
# database and then runs the API against it for the E2E suite. This one stops
# at the database, because the isolation proof does not need a server — it
# needs a connection whose current_user is app_tenant.
#
# Nothing here touches a real environment. The guard below refuses anything
# that looks like one, and the role password set at the end is for a local
# database that is dropped and recreated on every run.
#
# Usage:
#   ./scripts/rls-proof-setup.sh                     # uses a local server on :55432
#   RLS_PG_PORT=5433 ./scripts/rls-proof-setup.sh    # or point it elsewhere
#
# Then:
#   export RLS_TEST_DATABASE_URL='postgres://postgres@localhost:55432/rls_proof?sslmode=disable'
#   npx jest src/__tests__/rls.isolation.integration.test.js

set -euo pipefail

PORT="${RLS_PG_PORT:-55432}"
DB="${RLS_PG_DATABASE:-rls_proof}"
HOST="${RLS_PG_HOST:-localhost}"
SUPER="${RLS_PG_SUPERUSER:-postgres}"
TENANT_PASSWORD="${RLS_TEST_TENANT_PASSWORD:-localproof}"
BASE="postgres://${SUPER}@${HOST}:${PORT}"

case "$BASE" in
  *supabase*|*pooler*|*amazonaws*|*rds*)
    echo "Refusing to run: this looks like a real environment." >&2; exit 1 ;;
esac

echo "==> Recreating $DB on $HOST:$PORT"
psql "$BASE/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"

echo "==> Extensions"
for e in pgcrypto pg_trgm unaccent vector; do
  psql "$BASE/$DB" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS \"$e\";"
done

echo "==> Supabase-compatible roles"
# The RLS migrations REVOKE from anon/authenticated, which errors if the roles
# do not exist. Supabase ships them; a vanilla PostgreSQL does not.
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
SQL

echo "==> Baseline schema"
# migrate.js starts at 001, which ALTERs tables schema.sql creates.
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -q -f src/db/schema.sql

echo "==> Migrations (includes 157, which creates app_tenant and the policies)"
DATABASE_URL="$BASE/$DB?sslmode=disable" node src/db/migrate.js

echo "==> Local password for app_tenant"
# 157 deliberately sets no password — a migration is version-controlled. This
# one is for a throwaway database and is recreated on every run.
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -q -c "ALTER ROLE app_tenant PASSWORD '$TENANT_PASSWORD';"

echo "==> Sanity"
psql "$BASE/$DB" -v ON_ERROR_STOP=1 -qtA <<'SQL'
SELECT '    app_tenant bypassrls=' || rolbypassrls || ' super=' || rolsuper FROM pg_roles WHERE rolname='app_tenant';
SELECT '    tenant_isolation policies: ' || count(*) FROM pg_policies WHERE policyname='tenant_isolation';
SQL

cat <<EOF

Ready.

  export RLS_TEST_DATABASE_URL='$BASE/$DB?sslmode=disable'
  npx jest src/__tests__/rls.isolation.integration.test.js
EOF
