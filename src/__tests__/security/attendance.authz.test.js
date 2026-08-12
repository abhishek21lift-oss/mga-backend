// AUD-004 (P1) — /api/attendance is the studio's back office, not a client surface.
//
// ── The vulnerability these tests reproduce ─────────────────────────────────
//
// All eight routes are mounted with `auth` alone. server.js gates the mount with
// `gate('attendance')`, which is `[auth, requireFeature('attendance')]` — a
// feature flag, not a role check. Inside the router, PUT and DELETE do carry an
// ownership check, but it is written as:
//
//     if (req.user.role === 'trainer') { ...is this client yours?... }
//
// so an account with role `member` falls straight through it.
//
// The consequence, with an ordinary session and no exploit: an activated client
// can read the studio's entire attendance register — every other client's name,
// dates, check-in and check-out times — and can edit or delete any row in it.
// One activated client login exists in production today, and the client
// activation feature exists to create them in bulk.
//
// Members are not losing a surface here: their own attendance is served by
// GET /api/me/attendance (modules/client-portal/client-portal.routes.js), which
// scopes to req.user.pt_client_id.
//
// ── Why these assertions are shaped the way they are ───────────────────────
//
// A 403 is asserted together with "the database was never touched". Checking
// only the status code would still pass against a handler that fetched every
// studio's rows and then filtered them in JavaScript — which is not
// authorization, it is a rendering decision.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  connect: jest.fn(),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Only `auth` is mocked — it stands in for "a valid session exists". The role
// gate under test is the REAL middleware/rbac.js, so these tests exercise the
// actual authorization code rather than a stand-in for it.
let mockUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  // server.js applies branchScope globally at `app.use('/api/', branchScope)`,
  // and the handlers read `req.branchScope.appendTo(...)`. Mounting the router
  // without it would be a harness that does not resemble production — the real
  // middleware is used, not a stub, so its behaviour is exercised too.
  a.use(require('../../middleware/branch-scope').branchScope);
  a.use('/api/attendance', require('../../routes/attendance'));
  a.use(errorHandler);
  return a;
}

const dbTouched = () => mockLog.length;

const CLIENT_A = {
  id: 'usr-client-a', role: 'member', organization_id: ORG_A,
  pt_client_id: 'ptc-a', member_id: 'mem-a', trainer_id: null,
};
const ADMIN_A   = { id: 'usr-admin-a', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'usr-admin-b', role: 'admin', organization_id: ORG_B, trainer_id: null };
const TRAINER_A = { id: 'usr-trainer-a', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };

beforeEach(() => {
  mockLog.length = 0;
  mockRows = [];
  mockUser = ADMIN_A;
});

// ── A. The client must not reach the back office ────────────────────────────
describe('A. an activated client is refused every attendance route', () => {
  const CASES = [
    ['GET  /',              (r) => r.get('/api/attendance')],
    ['GET  /today-summary', (r) => r.get('/api/attendance/today-summary')],
    ['GET  /stats',         (r) => r.get('/api/attendance/stats')],
    ['GET  /gaps',          (r) => r.get('/api/attendance/gaps')],
    ['POST /',              (r) => r.post('/api/attendance').send({ ref_id: 'ptc-x', type: 'client', status: 'present' })],
    ['POST /bulk',          (r) => r.post('/api/attendance/bulk').send({ records: [{ ref_id: 'ptc-x', status: 'present' }] })],
    ['PUT  /:id',           (r) => r.put('/api/attendance/att-1').send({ status: 'absent' })],
    ['DELETE /:id',         (r) => r.delete('/api/attendance/att-1')],
  ];

  test.each(CASES)('%s → 403 for role=member', async (_name, call) => {
    mockUser = CLIENT_A;
    const res = await call(request(app()));

    expect(res.status).toBe(403);
    // Refused before any query runs — the boundary is the role gate, not a
    // filter applied to rows that were already fetched.
    expect(dbTouched()).toBe(0);
  });

  test('the refusal does not leak the studio register in the error body', async () => {
    mockUser = CLIENT_A;
    mockRows = [{ id: 'att-1', ref_name: 'Another Client', check_in_time: '07:00' }];
    const res = await request(app()).get('/api/attendance');

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/Another Client/);
  });

  test('a member with no pt_client_id is refused too', async () => {
    // A half-built client account must not be a way in either.
    mockUser = { id: 'usr-half', role: 'member', organization_id: ORG_A, pt_client_id: null };
    const res = await request(app()).get('/api/attendance');
    expect(res.status).toBe(403);
    expect(dbTouched()).toBe(0);
  });
});

// ── B. Staff keep working ───────────────────────────────────────────────────
describe('B. staff are allowed, and stay inside their own organization', () => {
  test.each([
    ['admin',   () => ADMIN_A],
    ['trainer', () => TRAINER_A],
  ])('%s can read the register', async (_role, who) => {
    mockUser = who();
    const res = await request(app()).get('/api/attendance');
    expect(res.status).toBe(200);
    expect(dbTouched()).toBeGreaterThan(0);
  });

  test('the read is scoped to the caller organization', async () => {
    mockUser = ADMIN_A;
    await request(app()).get('/api/attendance');
    const scoped = mockLog.filter((q) => /organization_id/i.test(q.sql));
    expect(scoped.length).toBeGreaterThan(0);
    for (const q of scoped) expect(q.params).toContain(ORG_A);
  });

  test("staff of another studio never see ORG-A's rows", async () => {
    mockUser = ADMIN_B;
    await request(app()).get('/api/attendance');
    const scoped = mockLog.filter((q) => /organization_id/i.test(q.sql));
    for (const q of scoped) {
      expect(q.params).toContain(ORG_B);
      expect(q.params).not.toContain(ORG_A);
    }
  });

  test('a cross-tenant attendance id 404s rather than 403s', async () => {
    // 404, not 403: a 403 would confirm the id exists somewhere on the platform.
    mockUser = ADMIN_B;
    mockRows = []; // the scoped lookup finds nothing
    const res = await request(app()).put('/api/attendance/att-belonging-to-org-a').send({ status: 'absent' });
    expect(res.status).toBe(404);
    expect(mockLog.some((q) => /UPDATE attendance_logs SET/i.test(q.sql))).toBe(false);
  });

  test('a cross-tenant delete matches nothing and deletes nothing', async () => {
    mockUser = ADMIN_B;
    mockRows = [];
    const res = await request(app()).delete('/api/attendance/att-belonging-to-org-a');
    expect(res.status).toBe(404);
    expect(mockLog.some((q) => /DELETE FROM attendance_logs/i.test(q.sql))).toBe(false);
  });
});

// ── C. Tenant identity cannot be steered by the request ─────────────────────
describe('C. a non-super-admin cannot change their effective organization', () => {
  test('the x-org-id header is ignored', async () => {
    mockUser = ADMIN_A;
    await request(app()).get('/api/attendance').set('x-org-id', ORG_B);
    const scoped = mockLog.filter((q) => /organization_id/i.test(q.sql));
    expect(scoped.length).toBeGreaterThan(0);
    for (const q of scoped) {
      expect(q.params).toContain(ORG_A);
      expect(q.params).not.toContain(ORG_B);
    }
  });

  test('an organization_id query parameter is ignored', async () => {
    mockUser = ADMIN_A;
    await request(app()).get(`/api/attendance?organization_id=${ORG_B}`);
    for (const q of mockLog) expect(q.params || []).not.toContain(ORG_B);
  });

  test('an organization_id in the body is never stamped onto a write', async () => {
    mockUser = ADMIN_A;
    await request(app()).post('/api/attendance')
      .send({ ref_id: 'ptc-a', type: 'client', status: 'present', organization_id: ORG_B });
    const inserts = mockLog.filter((q) => /INSERT INTO attendance_logs/i.test(q.sql));
    for (const q of inserts) {
      expect(q.params).not.toContain(ORG_B);
      expect(q.params).toContain(ORG_A);
    }
  });

  test('a client cannot use the header to reach another studio either', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/attendance').set('x-org-id', ORG_B);
    expect(res.status).toBe(403);
    expect(dbTouched()).toBe(0);
  });
});
