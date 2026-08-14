// Phase 0 (P0-C) — the tenant boundary on the five tables migration 165 gives
// an organization_id to, plus the two write paths fixed alongside it.
//
// Findings V-01, V-02, V-09 and the mark-all-paid half of V-05 in
// TENANT_SECURITY_AUDIT.md. The two that matter most:
//
//   GET /api/progress/lifestyle-assessments  and
//   GET /api/progress/nutrition-assessments
//
// took an OPTIONAL client_id, so the request that omitted it built no WHERE
// clause at all and ran a bare `SELECT *`. Every studio's rows, to any
// authenticated caller, carrying smoking status, alcohol intake, stress and
// sleep scores, food allergies, medical conditions and coach notes. The PATCH
// routes matched on id alone and then wrote.
//
// The cause is worth pinning in a test rather than only in a commit message,
// because it is the shape of the whole P0 backlog: migrations 084 and 156
// tenant-scoped weekly_checkins, strength_logs, progress_photos, mobility and
// posture, and the two tables they skipped are exactly the two that leaked.
// There was no column to filter on. `tenantScope.convention.test.js` could not
// see it either — it derives its table list from organization_id presence, so a
// table without the column is invisible to the very guard meant to catch this.
//
// Static source analysis, matching mobilityPosture.orgScope.test.js next door
// and for the same stated reason: CI has no live database, and reading the
// source catches the regression on the branch instead of after it ships.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATION = path.join(SRC, 'db', 'migrations', '165_p0_tenant_isolation_backfillable.sql');
const PROGRESS = path.join(SRC, 'modules', 'progress', 'progress.routes.js');
const PT_OS = path.join(SRC, 'modules', 'pt-os', 'pt-os.routes.js');
const LEAVE = path.join(SRC, 'routes', 'leave.js');

const BACKFILLED = [
  'pt_lifestyle_assessments',
  'pt_nutrition_assessments',
  'pt_commissions',
  'pt_payouts',
  'leave_requests',
];

describe('migration 165 — organization_id on the derivable tenant tables', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it.each(BACKFILLED)('adds an indexed organization_id to %s', (table) => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations\\(id\\)`));
    expect(sql).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS idx_${table}_organization_id`));
  });

  it.each([
    ['pt_lifestyle_assessments', 'pt_clients'],
    ['pt_nutrition_assessments', 'pt_clients'],
    ['pt_commissions', 'pt_clients'],
    ['pt_payouts', 'trainers'],
    ['leave_requests', 'trainers'],
  ])('backfills %s from %s rather than leaving every existing row NULL', (table, parent) => {
    expect(sql).toMatch(new RegExp(`UPDATE ${table}[\\s\\S]{0,400}?FROM ${parent}\\b`));
  });

  // The two repointed foreign keys are the ones a backfill gets wrong, and it
  // fails silently when it does. pt_payouts.trainer_id named pt_trainers from
  // migration 019 until 145 moved it to trainers; pt_trainers has never held a
  // row, so a backfill joining it would attribute nothing at all and report
  // success. Same story for pt_commissions.client_id, repointed by 017 off the
  // empty legacy `clients` table onto pt_clients.
  it('does not backfill through pt_trainers or the legacy clients table', () => {
    expect(sql).not.toMatch(/FROM pt_trainers\b/);
    expect(sql).not.toMatch(/FROM clients\b/);
  });

  it('is additive — nothing tightened, nothing deleted, nothing dropped', () => {
    // NOT NULL belongs to 155_organization_id_not_null.sql, which does it
    // check-then-tighten so one orphaned row degrades to a warning rather than
    // taking the deploy down. migrate.js runs on every boot.
    expect(sql).not.toMatch(/SET NOT NULL/);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN/i);
  });

  it('guards the single-organization fallback on there being exactly one', () => {
    // The fallback exists so a fresh single-tenant install ends up correct. On
    // the live platform, which has six studios, it must be a no-op — without
    // the count guard it would hand every unattributable row to whichever
    // organization happens to sort first.
    const fallbacks = sql.match(/SET organization_id = \(SELECT id FROM organizations ORDER BY created_at LIMIT 1\)/g) || [];
    expect(fallbacks.length).toBeGreaterThan(0);
    const guards = sql.match(/\(SELECT count\(\*\) FROM organizations\) = 1/g) || [];
    expect(guards.length).toBe(fallbacks.length);
  });

  it('reports unattributable rows instead of leaving them silently invisible', () => {
    // A row left NULL fails closed — no tenant sees it, so nothing leaks — but
    // it is still data its owner can no longer reach. That has to be said at
    // migration time, not discovered later.
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
  });
});

// Isolate a handler body so an assertion about one route cannot be satisfied by
// code belonging to its neighbour.
//
// The boundary is "up to the next router.<verb>(", not a closing token. These
// files use two different handler styles — `wrap(async (req, res) => { ... }))`
// in the modules and a plain `async function(req, res) { ... })` in
// routes/leave.js — so matching on `}));` finds nothing in half of them and
// silently returns an empty slice, which passes any `not.toMatch` assertion.
// Anchoring on the next route registration works for both and cannot degrade
// to a vacuous pass.
function handlerOf(src, method, route) {
  const start = src.indexOf(`router.${method}('${route}'`);
  expect(start).toBeGreaterThan(-1);
  const next = src.slice(start + 1).search(/\brouter\.(get|post|put|patch|delete|use)\(/);
  const end = next === -1 ? src.length : start + 1 + next;
  const body = src.slice(start, end);
  expect(body.length).toBeGreaterThan(50);
  return body;
}

describe('V-01 / V-02 — lifestyle and nutrition assessments are tenant-scoped', () => {
  const src = fs.readFileSync(PROGRESS, 'utf8');

  it.each([
    ['/lifestyle-assessments'],
    ['/nutrition-assessments'],
  ])('GET %s filters by the caller\'s organization even with no client_id', (route) => {
    const body = handlerOf(src, 'get', route);
    expect(body).toContain('tenantScope(req)');
    expect(body).toMatch(/where\.push\(`organization_id = \$\$\{params\.length\}`\)/);
    // The regression this guards: client_id was the ONLY condition, so the
    // request without one produced an empty WHERE. The org predicate must be
    // pushed unconditionally on applyFilter, never inside the client_id branch.
    const orgAt = body.indexOf('organization_id');
    const clientAt = body.indexOf('client_id = $');
    expect(orgAt).toBeGreaterThan(-1);
    expect(orgAt).toBeLessThan(clientAt);
  });

  it.each([
    ['/lifestyle-assessments'],
    ['/nutrition-assessments'],
  ])('POST %s stamps the row so its own studio can still see it', (route) => {
    const body = handlerOf(src, 'post', route);
    // Unstamped rows are the mirror image of the leak: invisible to their owner
    // rather than visible to everyone. See 155_organization_id_not_null.sql.
    expect(body).toContain('orgIdOf(req)');
    expect(body).toMatch(/created_by,\s*organization_id/);
  });

  it.each([
    ['/lifestyle-assessments/:id'],
    ['/nutrition-assessments/:id'],
  ])('PATCH %s guards both the read and the write', (route) => {
    const body = handlerOf(src, 'patch', route);
    expect(body).toContain('tenantScope(req)');
    // Read guard.
    expect(body).toMatch(/AND organization_id = \$2/);
    // Write guard — a predicate that lives only in a preceding SELECT is the
    // shape that stops holding the first time somebody reorders the function.
    expect(body).toMatch(/writeGuard = ` AND organization_id = \$\$\{params\.length\}`/);
    expect(body).toMatch(/WHERE id = \$1\$\{writeGuard\}/);
  });
});

describe('V-09 — leave requests are tenant-scoped on every path', () => {
  const src = fs.readFileSync(LEAVE, 'utf8');

  it('resolves the tenant boundary at all', () => {
    expect(src).toContain("require('../lib/tenant-db')");
    expect(src).toContain('tenantScope');
    expect(src).toContain('orgIdOf');
  });

  it('scopes the list, which previously had no admin branch at all', () => {
    // A trainer's rows were pinned to their own trainer_id. Admin and manager
    // had no equivalent, so the list returned every studio's leave with trainer
    // name, email and phone attached.
    const body = handlerOf(src, 'get', '/');
    expect(body).toMatch(/orgFilter\(req, params\)/);
    // The manual $-counter has to start after whatever the org predicate
    // consumed, or the placeholders silently shift by one.
    expect(body).toMatch(/let idx = params\.length \+ 1/);
  });

  it('scopes the single-record read', () => {
    const body = handlerOf(src, 'get', '/:id');
    expect(body).toMatch(/orgFilter\(req, params/);
    expect(body).toMatch(/WHERE lr\.id = \$1/);
  });

  it('rejects a foreign trainer_id on create, and stamps the row', () => {
    const body = handlerOf(src, 'post', '/');
    expect(body).toMatch(/SELECT 1 FROM trainers WHERE id = \$1 AND organization_id = \$2/);
    expect(body).toMatch(/INSERT INTO leave_requests \([^)]*organization_id\)/);
    expect(body).toContain('orgIdOf(req)');
  });

  it('scopes the overlap check, which otherwise leaks by status code', () => {
    const body = handlerOf(src, 'post', '/');
    expect(body).toMatch(/overlapOrg/);
  });

  it.each([['/:id/approve'], ['/:id/reject']])(
    'POST %s cannot act on another studio\'s row',
    (route) => {
      const body = handlerOf(src, 'post', route);
      expect(body).toMatch(/orgFilter\(req, params, null\)/);
      expect(body).toMatch(/AND status = \$5' \+ \(orgGuard/);
    }
  );
});

describe('V-05 (partial) — mark-all-paid is bounded to one organization', () => {
  const src = fs.readFileSync(PT_OS, 'utf8');

  it('scopes the only write in the payout module whose WHERE names no id', () => {
    const body = handlerOf(src, 'post', '/payouts/mark-all-paid');
    expect(body).toMatch(/orgWhere\(req, params\)/);
    expect(body).toMatch(/WHERE month = \$1 AND status != 'paid'\$\{orgGuard\}/);
  });

  it('still passes the month as a bound parameter, not interpolated', () => {
    const body = handlerOf(src, 'post', '/payouts/mark-all-paid');
    expect(body).toMatch(/params = \[monthStart\]/);
    expect(body).not.toMatch(/\$\{monthStart\}/);
  });
});

describe('the convention guard no longer exempts routes/leave.js', () => {
  const guard = fs.readFileSync(path.join(__dirname, 'tenantScope.convention.test.js'), 'utf8');

  it('has dropped the exemption rather than reworded it', () => {
    // The old entry's reason covered the trainer self-lookup and the
    // name-resolution join, both true, and said the rows were "already scoped
    // to the caller" — which held for trainers and not for admins. The file it
    // exempted was leaking the whole time. Now that leave.js scopes properly it
    // belongs under the assertion like every other route, so the exemption must
    // be gone, not softened.
    expect(guard).not.toMatch(/^\s*'routes\/leave\.js':/m);
  });
});
