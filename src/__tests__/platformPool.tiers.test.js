'use strict';

/**
 * The three database tiers must stay three.
 *
 * Most super-admin suites mock db/pool and db/platformPool to the SAME object,
 * so their assertions about what SQL a handler ran keep working. That is
 * convenient and it deliberately blurs the one thing this file exists to
 * check: which pool a path actually reaches for.
 *
 *   MIGRATION_DATABASE_URL  → migrations only, never an HTTP request
 *   DATABASE_URL            → app_tenant, tenant requests, RLS by app.org_id
 *   PLATFORM_DATABASE_URL   → app_platform, super-admin routes only
 *
 * These are source-level checks on purpose. Exercising them against a real
 * database would only cover the paths a test happens to hit, and the ones that
 * matter are the rare write paths — the same reasoning as
 * borrowedClientScope.convention.test.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

describe('platform pool is a separate tier', () => {
  it('is built lazily, so requiring it opens nothing', () => {
    const src = read('db/platformPool.js');
    // A Pool constructed at module scope is a live object with timers and a
    // socket factory. shared.js pulls this module into every super-admin unit
    // test, where there is no database at all, and an eager pool surfaced as
    // an unreadable pg teardown crash that took the whole Jest run down.
    const moduleScopeNewPool = /^\s*(?:const|let|var)\s+\w+\s*=\s*new Pool\(/m.test(src);
    expect(moduleScopeNewPool).toBe(false);
    expect(src).toMatch(/function get\(\)/);
  });

  it('never silently falls back to the tenant credential in production', () => {
    const src = read('db/platformPool.js');
    // Falling back would not fail — it would appear to work and then return
    // zero rows from every platform route, because app_tenant with no org
    // context matches no strict policy. That is precisely the bug this tier
    // exists to fix, restored quietly.
    expect(src).toMatch(/NODE_ENV === 'production'/);
    expect(src).toMatch(/throw new Error\('PLATFORM_DATABASE_URL is required in production'\)/);
  });

  it('does not import tenant context — a platform request has no organisation', () => {
    // Comments stripped first: this file explains at length why it sets no
    // app.org_id, and a naive substring search would read that explanation as
    // the very thing it forbids.
    const code = read('db/platformPool.js')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/tenant-context/);
    expect(code).not.toMatch(/currentOrgId/);
    expect(code).not.toMatch(/set_config/);
  });

  it('routes the approval transaction and the audit trail through the platform pool', () => {
    const registrations = read('modules/platform/super-admin/registrations.js');
    const shared = read('modules/platform/super-admin/shared.js');

    // Approval writes organizations, trainers, users and subscription_events,
    // none of which app_tenant can reach for a brand-new organisation.
    expect(registrations).toMatch(/const client = await platformPool\.connect\(\)/);
    // activity_log is tenant-scoped by 157 and a platform action has no org.
    expect(shared).toMatch(/await platformPool\.query\(\s*\n?\s*`INSERT INTO activity_log/);
  });

  it('leaves the anonymous registration path on the tenant pool', () => {
    const src = read('modules/platform/super-admin/registrations.js');
    const create = src.slice(src.indexOf('async function create'), src.indexOf('async function list'));

    // 162's function is granted to app_tenant and to nobody else. Moving this
    // one call to the platform pool would give an UNAUTHENTICATED request a
    // connection that can read every organisation on the platform.
    expect(create).toMatch(/await pool\.query\(/);
    expect(create).not.toMatch(/platformPool/);
    expect(create).toMatch(/platform_submit_studio_registration/);
  });

  it('keeps tenant routes off the platform pool entirely', () => {
    const dir = path.join(SRC, 'routes');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /platformPool/.test(fs.readFileSync(path.join(dir, f), 'utf8')));

    // routes/ is the tenant surface. Anything here reaching for the platform
    // pool would hold cross-organisation rights on a request that has a
    // tenant, which is a tenant isolation failure however well-intentioned.
    expect(offenders).toEqual([]);
  });
});
