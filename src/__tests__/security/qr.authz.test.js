// AUD-004 (P1), QR half — /api/qr is a MIXED surface, and that is the point.
//
// ── Why this router is not blanket-gated ────────────────────────────────────
//
// The Phase 1 write-up recommended putting `requireStaff` on the /api/qr mount.
// Reading the handlers shows that would be wrong and would cause a client-facing
// outage. Three of the seven routes derive their subject from `req.user` and are
// self-scoped by construction:
//
//   GET  /generate      the caller's OWN check-in QR
//   POST /checkout      ends the caller's OWN open attendance row
//   GET  /my-history    the caller's OWN attendance history
//
// A client legitimately calls all three. Gating the mount would 403 a member
// trying to display their own check-in code.
//
// Two are studio-wide and must be staff-only:
//
//   POST /scan          marks ANYONE present from a signed payload
//   GET  /dashboard     live studio-wide attendance aggregates
//
// Two already carry their own RBAC and are left alone:
//
//   GET /generate/:type/:id   admin/manager/owner, or trainer for own client
//   GET /staff-report         inline admin check
//
// So this file tests two things that pull in opposite directions: that the two
// staff routes are closed, and that the three client routes stay open. The
// second half is regression protection — it is what stops a future "just add
// requireStaff to the mount" from shipping.

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

// Rate limiters are stubbed to pass through: they are orthogonal to
// authorization and their Redis store is not available in a unit test.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

let mockUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/qr', require('../../routes/qr-checkin'));
  a.use(errorHandler);
  return a;
}

const dbTouched = () => mockLog.length;

const CLIENT_A = {
  id: 'usr-client-a', role: 'member', organization_id: ORG_A,
  pt_client_id: 'ptc-a', member_id: 'mem-a', trainer_id: null,
};
const CLIENT_B = {
  id: 'usr-client-b', role: 'member', organization_id: ORG_B,
  pt_client_id: 'ptc-b', member_id: 'mem-b', trainer_id: null,
};
const ADMIN_A   = { id: 'usr-admin-a', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'usr-admin-b', role: 'admin', organization_id: ORG_B, trainer_id: null };
const TRAINER_A = { id: 'usr-trainer-a', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };

beforeEach(() => {
  mockLog.length = 0;
  mockRows = [];
  mockUser = ADMIN_A;
});

// ── B. The two studio-wide routes must be staff-only ────────────────────────
describe('B. staff-only QR routes refuse a client', () => {
  test('POST /scan → 403 for role=member', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).post('/api/qr/scan').send({ payload: 'anything' });

    expect(res.status).toBe(403);
    // Refused before the payload is even parsed — a client must not be able to
    // mark anybody present, including themselves, through the staff scanner.
    expect(dbTouched()).toBe(0);
  });

  test('GET /dashboard → 403 for role=member', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/qr/dashboard');

    expect(res.status).toBe(403);
    expect(dbTouched()).toBe(0);
  });

  test('a client of another studio is refused too', async () => {
    mockUser = CLIENT_B;
    expect((await request(app()).get('/api/qr/dashboard')).status).toBe(403);
    expect((await request(app()).post('/api/qr/scan').send({ payload: 'x' })).status).toBe(403);
    expect(dbTouched()).toBe(0);
  });

  test.each([
    ['admin',   () => ADMIN_A],
    ['trainer', () => TRAINER_A],
  ])('%s is allowed through the role gate on /dashboard', async (_r, who) => {
    mockUser = who();
    const res = await request(app()).get('/api/qr/dashboard');
    // The assertion is on the AUTHORIZATION boundary, not on the aggregation:
    // the dashboard fans out five queries whose result shapes this mock does
    // not fully reproduce. "not 403" is exactly the property under test.
    expect(res.status).not.toBe(403);
    expect(dbTouched()).toBeGreaterThan(0);
  });

  test('the dashboard is scoped to the caller organization', async () => {
    mockUser = ADMIN_A;
    await request(app()).get('/api/qr/dashboard');
    const scoped = mockLog.filter((q) => /organization_id/i.test(q.sql));
    expect(scoped.length).toBeGreaterThan(0);
    for (const q of scoped) expect(q.params).toContain(ORG_A);
  });

  test('x-org-id does not move a staff caller to another studio', async () => {
    mockUser = ADMIN_A;
    await request(app()).get('/api/qr/dashboard').set('x-org-id', ORG_B);
    const scoped = mockLog.filter((q) => /organization_id/i.test(q.sql));
    for (const q of scoped) {
      expect(q.params).toContain(ORG_A);
      expect(q.params).not.toContain(ORG_B);
    }
  });
});

// ── C. The three client routes must KEEP working ────────────────────────────
describe('C. client-facing QR routes stay open and stay self-scoped', () => {
  test('GET /generate works for a client and returns THEIR identity', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/qr/generate');

    expect(res.status).toBe(200);
    expect(res.body.dataUrl).toMatch(/^data:image\/png;base64,/);
    // Subject comes from req.user (member_id), never from the request.
    expect(res.body.userId).toBe('mem-a');
    expect(res.body.userType).toBe('client');
  });

  test('GET /generate ignores any id the caller tries to supply', async () => {
    mockUser = CLIENT_A;
    const res = await request(app())
      .get('/api/qr/generate?userId=mem-b&user_id=mem-b&client_id=ptc-b');

    expect(res.status).toBe(200);
    // Still their own — the handler reads req.user and nothing else.
    expect(res.body.userId).toBe('mem-a');
  });

  test('GET /my-history works for a client and queries only their own rows', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/qr/my-history');

    expect(res.status).toBe(200);
    const q = mockLog.find((x) => /FROM attendance_logs/i.test(x.sql));
    expect(q.sql).toMatch(/ref_id = \$1 AND ref_type = \$2/);
    expect(q.params[0]).toBe('mem-a');
    expect(q.params[0]).not.toBe('mem-b');
  });

  test('GET /my-history cannot be pointed at another client', async () => {
    mockUser = CLIENT_A;
    await request(app()).get('/api/qr/my-history?ref_id=mem-b&member_id=mem-b&user_id=usr-client-b');

    const q = mockLog.find((x) => /FROM attendance_logs/i.test(x.sql));
    expect(q.params[0]).toBe('mem-a');
    expect(q.params).not.toContain('mem-b');
  });

  test('POST /checkout works for a client and only closes their own row', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).post('/api/qr/checkout').send({});

    expect(res.status).toBe(200);
    const q = mockLog.find((x) => /UPDATE attendance_logs/i.test(x.sql));
    expect(q.params[0]).toBe('mem-a');
    expect(q.params[1]).toBe('client');
  });

  test('POST /checkout ignores a ref_id supplied in the body', async () => {
    mockUser = CLIENT_A;
    await request(app()).post('/api/qr/checkout')
      .send({ ref_id: 'mem-b', user_id: 'usr-client-b', organization_id: ORG_B });

    const q = mockLog.find((x) => /UPDATE attendance_logs/i.test(x.sql));
    expect(q.params[0]).toBe('mem-a');
    expect(q.params).not.toContain('mem-b');
    expect(q.params).not.toContain(ORG_B);
  });
});

// ── D. The already-protected routes stay protected ──────────────────────────
describe('D. routes that already carry their own RBAC are unchanged', () => {
  test('GET /generate/:type/:id refuses a client', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/qr/generate/client/ptc-b');
    expect(res.status).toBe(403);
  });

  test('GET /generate/:type/:id refuses a trainer a client that is not theirs', async () => {
    mockUser = TRAINER_A;
    mockRows = []; // the ownership lookup finds no assignment
    const res = await request(app()).get('/api/qr/generate/client/ptc-not-mine');
    expect(res.status).toBe(403);
  });

  test('GET /staff-report refuses a client', async () => {
    mockUser = CLIENT_A;
    const res = await request(app()).get('/api/qr/staff-report');
    expect(res.status).toBe(403);
  });

  test('GET /staff-report refuses a trainer (admin only)', async () => {
    mockUser = TRAINER_A;
    const res = await request(app()).get('/api/qr/staff-report');
    expect(res.status).toBe(403);
  });

  test('GET /staff-report is scoped for an admin', async () => {
    mockUser = ADMIN_B;
    await request(app()).get('/api/qr/staff-report');
    const q = mockLog.find((x) => /FROM attendance_logs/i.test(x.sql));
    expect(q.params).toContain(ORG_B);
    expect(q.params).not.toContain(ORG_A);
  });
});
