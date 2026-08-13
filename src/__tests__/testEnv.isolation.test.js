'use strict';

/**
 * A test worker must not hold production configuration.
 *
 * src/db/pool.js is required, directly or transitively, by 129 files. It used
 * to call dotenv.config() unconditionally, so a single suite that reached the
 * real pool pulled the repository .env into the worker — and on a developer
 * machine that file holds the production connection string and the production
 * JWT signing key. The pool then opened a connection to prove readiness.
 *
 * Measured before the fix, inside a worker:
 *
 *   DATABASE_URL before requiring db/pool : unset
 *   DATABASE_URL after                    : aws-0-ap-south-1.pooler.supabase.com
 *   pool.totalCount                       : 1
 *
 * A live connection to production, from a unit test.
 *
 * These assertions are the tripwire. They fail if dotenv returns to the Jest
 * path, if jest.setup.env.js stops being registered, or if someone "fixes" a
 * failing test by pointing it at a real database — which is the specific
 * mistake most likely to look like progress at the time.
 */

// Hosts that would mean a worker is talking to something real. Deliberately
// not an allowlist of test values: the point is to catch production, not to
// prescribe what a local database must be called.
const PRODUCTION_HOSTS = /supabase\.co|pooler\.supabase\.com|amazonaws\.com|render\.com/i;

const DB_KEYS = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'PLATFORM_DATABASE_URL'];

describe('test environment isolation', () => {
  it('registers the setup file that pins the environment', () => {
    // If this is ever removed, every assertion below becomes vacuous — they
    // would pass on a machine with no .env and fail only on the developer's,
    // which is the worst possible distribution of a security failure.
    const cfg = require('../../jest.config.js');
    expect(cfg.setupFiles).toEqual(expect.arrayContaining([expect.stringContaining('jest.setup.env')]));
  });

  it.each(DB_KEYS)('%s does not point at production', (key) => {
    const url = process.env[key];
    expect(url).toBeTruthy();
    expect(url).not.toMatch(PRODUCTION_HOSTS);
  });

  it('requiring db/pool does not import .env into the worker', () => {
    const before = DB_KEYS.map((k) => process.env[k]);
    require('../db/pool');
    const after = DB_KEYS.map((k) => process.env[k]);

    // The exact regression: dotenv only fills variables that are unset, so a
    // reintroduced config() call would be invisible unless something checks
    // that the values did not change across the require.
    expect(after).toEqual(before);
    after.forEach((url) => expect(url).not.toMatch(PRODUCTION_HOSTS));
  });

  it('requiring db/pool opens no connection', () => {
    const pool = require('../db/pool');
    // The readiness probe is a deploy-time check. In a worker it starts a
    // handshake that can outlive the suite, and against a remote TLS endpoint
    // that is how a stray socket error ends up attributed to an unrelated
    // test.
    expect(pool.totalCount).toBe(0);
  });

  it('holds no production JWT signing key', () => {
    // Worse than a database connection: whatever can read this can mint a
    // valid session for any tenant on the platform.
    expect(process.env.JWT_SECRET).toBeTruthy();
    expect(process.env.JWT_SECRET).toMatch(/test/i);
  });

  it('has no provider credentials at all', () => {
    // None of these are in .env today. The assertion is here so that adding
    // one later does not silently make it available to every test in the
    // suite — it has to be an explicit decision, visible in this file.
    for (const key of ['OPENROUTER_API_KEY', 'RAZORPAY_KEY_SECRET', 'R2_SECRET_ACCESS_KEY',
      'GOOGLE_CLIENT_SECRET', 'WHATSAPP_TOKEN', 'SMTP_PASS', 'AWS_SECRET_ACCESS_KEY']) {
      expect(process.env[key] || '').toBe('');
    }
  });
});
