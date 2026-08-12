// Regression test for audit finding C-1.
//
// /api/admin (admin-reset.js) runs platform-wide, unscoped destructive
// operations — DELETE across every tenant's attendance/payments/invoices/
// clients, and DROP TABLE outstanding_dues — with no organization_id filter
// anywhere in the handlers. It was previously gated by `adminOnly`, which
// only checks role==='admin' — the ordinary Studio Owner role auto-granted to
// every self-serve trial signup (registrations.js). That let any trial
// signup wipe every tenant on the platform in two authenticated requests.
//
// The fix mirrors the mount already used for /api/super-admin in server.js:
// auth -> requireSuperAdmin -> requireSuperAdminMfa. This test exercises that
// exact chain (not a stand-in) against the real admin-reset router, so a
// future edit that quietly swaps the mount back to `adminOnly` — or that adds
// a per-route middleware bypassing it — fails here.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  adminOnly: (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  },
}));

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));
jest.mock('../lib/email', () => ({ sendAdminResetOtp: jest.fn(async () => {}) }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { requireSuperAdmin, requireSuperAdminMfa } = require('../middleware/tenant');

// Mirrors server.js's real mount line for /api/admin exactly, so this test
// fails if that line ever regresses back to adminOnly.
const app = express();
app.use(express.json());
app.use('/api/admin', (req, res, next) => require('../middleware/auth').auth(req, res, next),
  requireSuperAdmin, requireSuperAdminMfa, require('../routes/admin-reset'));

const TENANT_ADMIN = { id: 'usr-owner', role: 'admin', organization_id: 'org-a' };
const SUPER_ADMIN = { id: 'usr-platform', role: 'super_admin', organization_id: null };
const TRAINER = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-a' };

beforeEach(() => {
  pool.query.mockClear();
});

describe('POST /api/admin/* — must be platform super_admin only', () => {
  const endpoints = ['/initiate-reset', '/reset-all-data', '/reset-outstanding-dues'];

  it.each(endpoints)('rejects an ordinary tenant Studio Owner (role=admin) on %s with 403, before touching the database', async (path) => {
    mockCurrentUser = TENANT_ADMIN;
    const res = await request(app).post(`/api/admin${path}`).send({ otp: '123456' });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each(endpoints)('rejects a non-admin tenant role on %s with 403', async (path) => {
    mockCurrentUser = TRAINER;
    const res = await request(app).post(`/api/admin${path}`).send({ otp: '123456' });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('lets a platform super_admin past the auth gate (reaches the route handler)', async () => {
    mockCurrentUser = SUPER_ADMIN;
    const res = await request(app).post('/api/admin/initiate-reset').send({ action: 'reset-all' });
    // Not 403 — the gate passed and the real handler ran (and hit the mocked pool).
    expect(res.status).not.toBe(403);
    expect(pool.query).toHaveBeenCalled();
  });
});
