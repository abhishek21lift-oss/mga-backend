// Two platform guarantees that were already implemented correctly but had no
// test — so nothing would have caught them being removed.
//
//   1. Support Mode is read-only ON THE SERVER, not just in the banner. The
//      Control Centre tells an operator their session is read-only; if that
//      were enforced in the UI alone, the promise would be cosmetic.
//   2. Every mutating platform action writes an audit row. Rule 4 of the
//      Control Centre spec: nothing happens silently.

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

const ADMIN = {
  id: 'usr-admin', name: 'Studio Admin', email: 'a@x.com', role: 'admin',
  organization_id: '11111111-1111-1111-1111-111111111111',
  token_version: 1, is_active: true, deleted_at: null,
};

function impToken({ ro }) {
  return jwt.sign(
    {
      id: ADMIN.id,
      token_version: ADMIN.token_version,
      imp: { by: 'usr-super', byName: 'Operator', ro, org: ADMIN.organization_id },
    },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(auth);
  a.get('/thing', (_q, s) => s.json({ ok: true }));
  a.post('/thing', (_q, s) => s.json({ ok: true }));
  a.patch('/thing', (_q, s) => s.json({ ok: true }));
  a.delete('/thing', (_q, s) => s.json({ ok: true }));
  return a;
}

beforeEach(() => {
  pool.query.mockReset();
  // Every auth() call loads the user; subscription state is irrelevant here
  // because impersonation sessions bypass that check.
  pool.query.mockResolvedValue({ rows: [ADMIN] });
});

describe('Support Mode — read-only is enforced server-side', () => {
  it('allows reads', async () => {
    const res = await request(app()).get('/thing').set('Authorization', `Bearer ${impToken({ ro: true })}`);
    expect(res.status).toBe(200);
  });

  it.each(['post', 'patch', 'delete'])('blocks %s with IMPERSONATION_READONLY', async (method) => {
    const res = await request(app())[method]('/thing')
      .set('Authorization', `Bearer ${impToken({ ro: true })}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IMPERSONATION_READONLY');
  });

  it('permits writes in an explicit full-access session', async () => {
    // 'full' is a deliberate escalation the operator confirms; it stays
    // audited, but it is not blocked.
    const res = await request(app()).post('/thing')
      .set('Authorization', `Bearer ${impToken({ ro: false })}`);
    expect(res.status).toBe(200);
  });
});

describe('Audit coverage — nothing happens silently', () => {
  // Read every domain router, not one file.
  //
  // This used to read super-admin.routes.js directly. Audit H-03 split that
  // 4,248-line module into src/modules/platform/super-admin/*.js and left the
  // original path as a mount list, at which point this check found zero routes
  // and PASSED VACUOUSLY — the "meaningful number of routes" test below is the
  // only reason that was noticed. Globbing the directory means a new domain
  // file is covered the moment it is added, with nothing to remember.
  const DIR = path.join(__dirname, '..', 'modules', 'platform', 'super-admin');
  const files = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && f !== 'shared.js')
    .sort();
  const src = files.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');

  // The single documented exception: it resolves who WOULD receive an
  // announcement and writes nothing. A POST only because it needs a body.
  const READ_ONLY_POSTS = ['/announcements/:id/preview'];

  it('found the domain routers to read', () => {
    // Guards the glob itself: a rename or a moved directory must fail loudly
    // rather than quietly reducing this suite to nothing.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('organizations.js');
  });

  it('audits every mutating super-admin route', () => {
    const parts = src.split(/\nrouter\.(get|post|put|patch|delete)\('([^']+)'/);
    const unaudited = [];
    for (let i = 1; i + 2 <= parts.length; i += 3) {
      const [method, route, body] = [parts[i], parts[i + 1], parts[i + 2]];
      if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (READ_ONLY_POSTS.includes(route)) continue;
      // Either the shared helper or a direct write — several routes insert
      // richer context (previous value, studios affected) than audit() takes.
      const audited = body.includes('await audit(') || body.includes('activity_log');
      if (!audited) unaudited.push(`${method.toUpperCase()} ${route}`);
    }
    expect(unaudited).toEqual([]);
  });

  it('checks a meaningful number of routes, so the test cannot pass vacuously', () => {
    const mutating = [...src.matchAll(/\nrouter\.(post|put|patch|delete)\('/g)].length;
    expect(mutating).toBeGreaterThan(30);
  });

  it('calls audit() with the payload in the data position, not the entity type', () => {
    // audit(req, action, entityType, entityId, data) — five arguments.
    //
    // Passing the payload third is the easy mistake, and it fails silently in
    // the worst way: entity_type is a text column, so pg stringifies the
    // object into it, entity_id and new_data land null, and audit() swallows
    // any error by design. The row is written, the request succeeds, and the
    // audit trail has lost exactly the context it existed to keep. The
    // registrations module shipped with four such calls before this test.
    const offenders = [...src.matchAll(/audit\(\s*req\s*,\s*'([a-z_]+)'\s*,\s*\{/g)]
      .map((m) => m[1]);
    expect(offenders).toEqual([]);
  });
});
