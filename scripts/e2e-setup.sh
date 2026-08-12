#!/usr/bin/env bash
# Build the stack the E2E suite needs: a real Postgres with the real migrations
# applied, two seeded studios, and the API running against them.
#
# Audit finding H-10. Every test that existed mocked one side of the boundary —
# Jest with a mocked pg pool, Vitest with a mocked fetch — so the property this
# product sells, that one studio cannot see another's data, had never been
# checked against a real database. Tests that mock the database away cannot
# fail for the reason isolation actually breaks.
#
# Deliberately a script rather than Playwright `webServer`: a server that starts
# successfully while pointing at the wrong database is exactly how an isolation
# test passes for the wrong reason, so the database is set up explicitly and
# verified before anything is served.
#
# Usage:  ./scripts/e2e-setup.sh          (assumes DATABASE_URL points somewhere throwaway)
#
# Requires: a reachable Postgres with the pgvector extension available, and the
# Supabase-compatible roles (anon / authenticated / service_role) that the RLS
# migrations grant against.

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a THROWAWAY database}"
: "${JWT_SECRET:=e2e-test-secret-at-least-32-characters-long!!}"
: "${FRONTEND_URL:=http://127.0.0.1:3100}"
: "${PORT:=5100}"
export JWT_SECRET FRONTEND_URL PORT
export NODE_ENV="${NODE_ENV:-development}"
export RUN_WORKERS=0

case "$DATABASE_URL" in
  *supabase*|*pooler*|*amazonaws*)
    echo "Refusing to run: DATABASE_URL looks like a real environment." >&2
    exit 1
    ;;
esac

# psql gets DATABASE_URL unchanged.
#
# This used to append `?sslmode=require`, which broke the job in two ways. It
# forced SSL onto a server that may not have it — a CI service container and a
# local docker Postgres are both built without it, and libpq then refuses to
# connect rather than falling back — and it appended a `?` blindly, so a URL
# that already carried a query string became malformed.
#
# Passing the URL through means libpq's own default applies (`prefer`: use SSL
# when the server offers it, plain otherwise), and an explicit `sslmode=` in
# the URL is honoured for both psql and the Node pool, which reads the same
# parameter. One URL, one answer.
PSQL_URL="$DATABASE_URL"

echo "==> Supabase-compatible roles"
# The RLS migrations REVOKE from anon/authenticated, which errors if the roles
# do not exist. Supabase ships them; a vanilla Postgres does not.
psql "$PSQL_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
SQL

echo "==> Baseline schema"
# migrate.js starts at 001, which ALTERs tables schema.sql creates — so a fresh
# database needs the baseline first. This is not automated anywhere else, which
# is worth knowing when standing up a new environment.
psql "$PSQL_URL" -v ON_ERROR_STOP=1 -q -f src/db/schema.sql

echo "==> Migrations"
node src/db/migrate.js

echo "==> Seed two studios"
node scripts/seed-e2e.js

echo "==> API on :$PORT"
node src/server.js &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  # 503 counts as up: /api/health reports unhealthy when Redis is absent even
  # though the API serves normally (a separate finding). Anything that is not a
  # connection failure means the port is answering.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/api/health" || true)
  [ "$code" != "000" ] && { echo "    API answering (health=$code)"; break; }
  sleep 2
done

echo "==> Ready. API on :$PORT — run the E2E suite from the frontend repo."
wait "$API_PID"
