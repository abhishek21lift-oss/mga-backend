'use strict';
// The write paths a studio's own trainers and admins actually use most —
// creating/editing/removing a client, recording/removing a payment, changing
// a trainer's commission — are now audited through activityLog's
// logActivity(), and there's a tenant-scoped way for a studio's own
// admin/manager to read the trail back (GET /activity-log). Pinned
// statically, same reasoning as this repo's other route-convention tests:
// these handlers are large enough that a full integration harness per route
// would be its own project, and what actually matters here — is the call
// present, is it scoped to the tenant, does it fire on the success path —
// is verifiable by reading the source.

const fs = require('fs');
const path = require('path');

const ptOs = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.routes.js'), 'utf8');
const payments = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');

describe('client writes are audited', () => {
  it('logs create, update and delete, each with the record\'s own id', () => {
    expect(ptOs).toMatch(/logActivity\(req, 'client\.create', 'pt_client', rows\[0\]\.id/);
    expect(ptOs).toMatch(/logActivity\(req, 'client\.update', 'pt_client', rows\[0\]\.id/);
    expect(ptOs).toMatch(/logActivity\(req, 'client\.delete', 'pt_client', rows\[0\]\.id/);
  });

  it('every logActivity call in this file is awaited, matching the rest of the app\'s convention', () => {
    const calls = [...ptOs.matchAll(/(await )?logActivity\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(m[1]).toBe('await ');
  });
});

describe('the trainer commission endpoint', () => {
  const fn = ptOs.slice(ptOs.indexOf("router.put('/commissions/:trainerId'"));
  const body = fn.slice(0, fn.indexOf('\n}));')) + '\n}));';

  it('is now tenant-scoped — it had no organization filter at all before this', () => {
    // Same helper every sibling write in this file already uses.
    expect(body).toMatch(/orgWhere\(req, beforeParams\)/);
    expect(body).toMatch(/orgWhere\(req, updParams\)/);
  });

  it('404s a cross-tenant trainer id rather than updating it', () => {
    expect(body).toContain("if (before.length === 0) return res.status(404)");
  });

  it('logs the before and after commission rate, not just that something changed', () => {
    expect(body).toContain("logActivity(");
    expect(body).toContain("'trainer.commission_update'");
    expect(body).toContain('{ incentive_rate: rate }');
    expect(body).toContain('{ incentive_rate: before[0].incentive_rate }');
  });
});

describe('payment writes are audited', () => {
  it('logs create only after COMMIT — never before, where a later rollback could make the row a lie', () => {
    const create = payments.slice(payments.indexOf("router.post('/', auth"));
    const commitAt = create.indexOf("tx.query('COMMIT')");
    const logAt = create.indexOf("logActivity(req, 'payment.create'");
    expect(commitAt).toBeGreaterThan(-1);
    expect(logAt).toBeGreaterThan(commitAt);
  });

  it('logs delete on both ledgers it can delete from (canonical pt_payments and the legacy table)', () => {
    const del = payments.slice(payments.indexOf("router.delete('/:id'"));
    const calls = [...del.matchAll(/logActivity\(req, 'payment\.delete'/g)];
    expect(calls.length).toBe(2);
  });

  it('every logActivity call in this file is awaited', () => {
    const calls = [...payments.matchAll(/(await )?logActivity\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(m[1]).toBe('await ');
  });
});

describe('GET /activity-log — the studio-facing read of the trail', () => {
  const route = ptOs.slice(ptOs.indexOf("router.get('/activity-log'"));
  const body = route.slice(0, route.indexOf('module.exports'));

  it('is admin/manager only, not open to every signed-in role', () => {
    expect(route.slice(0, route.indexOf('wrap('))).toContain('adminOrManager');
  });

  it('filters to the caller\'s own organization unconditionally — never an optional clause a query param could skip', () => {
    // Every sibling read in this file guards the org filter behind
    // scope.applyFilter (true for a studio user, false only for a platform
    // super admin operating platform-wide) — but adminOrManager already
    // rejects super_admin outright, so this endpoint has no "see everything"
    // path to accidentally leave open. The filter is unconditional, not
    // behind an if.
    expect(body).toContain("const where = ['a.organization_id = $1']");
    expect(body).toContain('const params = [scope.orgId]');
    expect(body).not.toMatch(/if \(scope\.applyFilter\)/);
  });

  it('never accepts an org id from the request — only ever the caller\'s own', () => {
    expect(body).not.toMatch(/req\.query\.org(anization)?_id/);
    expect(body).not.toMatch(/req\.body\.org(anization)?_id/);
    expect(body).not.toMatch(/x-org-id/);
  });

  it('paginates rather than returning the whole table', () => {
    expect(body).toContain('LIMIT $');
    expect(body).toContain('OFFSET $');
    expect(body).toMatch(/Math\.min\(Math\.max\(parseInt\(req\.query\.limit/);
  });
});
