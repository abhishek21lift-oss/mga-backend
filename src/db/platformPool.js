'use strict';
/**
 * The platform connection pool — tier three.
 *
 *   MIGRATION_DATABASE_URL  → migrations and schema changes, never an HTTP request
 *   DATABASE_URL            → app_tenant, every tenant request, RLS by app.org_id
 *   PLATFORM_DATABASE_URL   → app_platform, super-admin routes only
 *
 * The three are separate credentials on purpose. A platform request is not a
 * tenant request with extra rights: it has no organisation at all, so the
 * app.org_id equality that every tenant_isolation policy rests on can never be
 * satisfied for it. Rather than weaken those policies, 163 gave app_platform
 * its own allowlist and its own policies, and this pool is how a route reaches
 * them.
 *
 * ── No AsyncLocalStorage here ────────────────────────────────────────────
 *
 * db/pool.js wraps query() and connect() to inject app.org_id from the request
 * context. This pool deliberately does not, and must not: setting a tenant GUC
 * on a platform connection would be meaningless (no platform policy reads it)
 * and misleading (it would suggest platform access is tenant-scoped when it is
 * not). Platform authorisation lives entirely in the HTTP layer —
 * auth → requireSuperAdmin → requireSuperAdminMfa — and this pool is only
 * reachable from routes behind all three.
 *
 * ── Why it fails fast ────────────────────────────────────────────────────
 *
 * Falling back to DATABASE_URL when PLATFORM_DATABASE_URL is missing would be
 * the worst possible default. It would not fail; it would appear to work, and
 * then every platform route would silently return zero rows — because
 * app_tenant with no org context matches no strict policy — which is exactly
 * the bug this tier exists to fix, restored quietly and in production.
 *
 * Outside production a fallback is allowed, because a developer's local
 * database routinely has one superuser and no roles at all. It is loud, it is
 * refused when NODE_ENV is production, and it can never grant more than the
 * credential already in DATABASE_URL — it cannot escalate, only fail earlier.
 */

const { Pool } = require('pg');
const logger = require('../lib/logger');

const PLATFORM_URL = process.env.PLATFORM_DATABASE_URL || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let connectionString = PLATFORM_URL;

if (!PLATFORM_URL) {
  if (IS_PRODUCTION) {
    // Fatal by design. A platform route that cannot reach the platform role
    // must not start rather than answer 200 with an empty Command Centre.
    logger.error(
      'PLATFORM_DATABASE_URL is not set. Super-admin routes require the app_platform '
      + 'role (migration 163) and will not fall back to DATABASE_URL in production — '
      + 'app_tenant has no organisation context and would silently return no rows.',
    );
    throw new Error('PLATFORM_DATABASE_URL is required in production');
  }
  connectionString = process.env.DATABASE_URL || '';
  logger.warn(
    'PLATFORM_DATABASE_URL is not set; falling back to DATABASE_URL for platform '
    + 'routes. Development only — this cannot escalate privilege, but platform '
    + 'routes will return no rows unless DATABASE_URL is a role that can read '
    + 'across organisations.',
  );
}

/**
 * Built on first use, never at require time.
 *
 * shared.js pulls this module in, so every unit test that touches a
 * super-admin handler loads it — with no database anywhere and usually no
 * connection string at all. A Pool constructed then is a live object with a
 * timer and a socket factory: harmless-looking, but it surfaces much later as
 * "Cannot read properties of undefined (reading 'isIP')" inside pg's teardown,
 * which kills the Jest worker before the run can print its summary. That is
 * how this file first broke the suite, and a lazy pool is the fix that removes
 * the failure mode rather than the symptom — requiring the module now costs
 * nothing and reaches nothing.
 */
let pool = null;

function get() {
  if (pool) return pool;
  if (!connectionString) {
    // Named, and thrown where the caller can act on it, rather than surfacing
    // as an obscure socket error two layers down.
    throw new Error(
      'PLATFORM_DATABASE_URL is not set (and no DATABASE_URL to fall back to) — '
      + 'platform routes require the app_platform role from migration 163',
    );
  }
  pool = new Pool({
    connectionString,
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
    // Smaller than the tenant pool on purpose: platform traffic is a handful
    // of operators, not every request on the platform, and these connections
    // hold cross-organisation read rights that should not sit idle in bulk.
    max: parseInt(process.env.PLATFORM_DB_POOL_MAX, 10) || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  });
  pool.on('error', (err) => logger.error({ err: err.message }, 'platform_pool_error'));
  return pool;
}

module.exports = {
  query: (...a) => get().query(...a),
  connect: (...a) => get().connect(...a),
  end: () => (pool ? pool.end() : Promise.resolve()),
  /**
   * True when this pool is backed by its own credential rather than the
   * development fallback, so a route can fail loudly instead of returning a
   * confusingly empty result.
   */
  isDedicated: Boolean(PLATFORM_URL),
};
