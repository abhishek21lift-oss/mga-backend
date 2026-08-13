'use strict';
/**
 * Runs before any module is loaded in a Jest worker.
 *
 * src/db/pool.js calls dotenv.config() at import, so any suite that reaches
 * the real pool — directly or through a service — inherits whatever .env
 * holds. On a developer machine that is the production connection string, and
 * the pool opens a connection to it on import to probe connectivity.
 *
 * Two things follow, and neither is acceptable:
 *
 *  · the test suite talks to the production database; and
 *  · that connection is a remote TLS handshake, which frequently outlives the
 *    suite that started it. Jest then tears down the module registry, and pg's
 *    connect path — which does `const net = require('net')` lazily, inside the
 *    TLS branch — gets undefined back and throws
 *
 *      Cannot read properties of undefined (reading 'isIP')
 *
 *    attributed to whichever unlucky test happened to be running. That is the
 *    intermittent teardown failure this file removes: not by silencing it, but
 *    by removing the remote connection that causes it.
 *
 * Pinning the URLs here rather than in each suite means a test cannot reach a
 * real database by forgetting to mock something. The value is deliberately a
 * local address with sslmode=disable: nothing listens on it in CI, so a suite
 * that genuinely tries to use it fails loudly and locally instead of quietly
 * succeeding against production.
 *
 * Anything already set in the environment wins, so CI jobs and the harnesses
 * in scripts/ that pass real disposable URLs are unaffected.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const UNREACHABLE = 'postgresql://test:test@127.0.0.1:1/mga_test_no_db?sslmode=disable';

for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'PLATFORM_DATABASE_URL']) {
  if (!process.env[key]) process.env[key] = UNREACHABLE;
}

// Real secrets, pinned to obvious test values. .env carries JWT_SECRET, and a
// worker holding the production token-signing key is a worse outcome than a
// stray database connection: anything that leaks it can mint valid sessions
// for every tenant. FRONTEND_URL is not secret but is pinned so redirect
// assertions do not depend on whose machine runs them.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-not-a-real-key-0000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Keep a suite from reaching a real broker for the same reason.
process.env.REDIS_URL = process.env.REDIS_URL || '';
process.env.RUN_WORKERS = process.env.RUN_WORKERS || '0';
