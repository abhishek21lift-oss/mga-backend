// The rest of /api/clients, consolidated onto pt_clients.
//
// This product is personal training, so there is one client entity. The legacy
// `clients` table models a gym membership and has held 0 rows since the PT-OS
// enrolment flow shipped, yet these four handlers still targeted it:
//
//   POST   /             inserted into clients + payments. It did not fail — it
//                        SUCCEEDED, writing a row with no organization_id that
//                        no read path could ever see, and skipping the plan
//                        seat check that /api/pt-os/clients enforces. Removed
//                        rather than repointed: duplicating org stamping and
//                        seat limits would leave two create paths for one
//                        entity.
//   DELETE /:id          matched nothing -> 404 for every client.
//   GET /:id/attendance  guard read `clients` -> 404 for every client.
//   GET /:id/payments    same guard, and read the empty `payments` ledger.
//
// The delete tests carry the weight here. Repointing a `WHERE id=$1` delete at
// pt_clients without a tenant clause would have let any studio destroy another
// studio's client by id — strictly worse than the 404 it replaced.
'use strict';

const CLIENT_ID = 'ptc-1';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

let mockClient = { id: CLIENT_ID, organization_id: ORG_A, trainer_id: 'tr-1', client_id: 'C-1' };
const mockQueries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT \* FROM pt_clients WHERE id/i.test(text)) {
      return { rows: mockClient ? [mockClient] : [], rowCount: mockClient ? 1 : 0 };
    }
    if (/^(UPDATE|DELETE FROM) pt_clients/i.test(text)) {
      return { rows: mockClient ? [{ id: CLIENT_ID }] : [], rowCount: mockClient ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

let mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.branchScope = { appendTo: (p) => ({ sql: 'TRUE', params: p || [] }) }; next(); });
  a.use('/api/clients', require('../routes/clients'));
  a.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return a;
}

const sqls = () => mockQueries.map((q) => q.sql);
const wrote = (re) => mockQueries.some((q) => re.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockClient = { id: CLIENT_ID, organization_id: ORG_A, trainer_id: 'tr-1', client_id: 'C-1' };
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('POST /clients is gone', () => {
  test('creating through this route is no longer possible', async () => {
    const res = await request(app()).post('/api/clients').send({ name: 'New Person' });

    expect(res.status).toBe(404);
    // The dangerous part was that it used to succeed. Nothing may be written.
    expect(wrote(/INSERT INTO/i)).toBe(false);
  });
});

describe('DELETE /clients/:id', () => {
  test('soft-deletes in pt_clients, not the legacy table', async () => {
    const res = await request(app()).delete(`/api/clients/${CLIENT_ID}`);

    expect(res.status).toBe(200);
    expect(wrote(/^UPDATE pt_clients SET deleted_at/i)).toBe(true);
    for (const s of sqls()) expect(s).not.toMatch(/\b(FROM|UPDATE|INTO) clients\b/i);
  });

  test('another studio cannot delete this client, and nothing is written', async () => {
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    mockClient = null; // the org-scoped lookup finds nothing
    const res = await request(app()).delete(`/api/clients/${CLIENT_ID}`);

    expect(res.status).toBe(404);
    expect(wrote(/UPDATE pt_clients SET deleted_at/i)).toBe(false);
    expect(wrote(/DELETE FROM pt_clients/i)).toBe(false);
  });

  test('the ownership lookup is org-scoped before any delete runs', async () => {
    await request(app()).delete(`/api/clients/${CLIENT_ID}`);

    const find = mockQueries.find((q) => /^SELECT \* FROM pt_clients WHERE id/i.test(q.sql));
    expect(find.sql).toMatch(/organization_id = \$2/);
    expect(find.params).toEqual([CLIENT_ID, ORG_A]);
  });

  test('hard delete is also org-guarded', async () => {
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    mockClient = null;
    const res = await request(app()).delete(`/api/clients/${CLIENT_ID}?hard=1`);

    expect(res.status).toBe(404);
    expect(wrote(/DELETE FROM pt_clients/i)).toBe(false);
  });

  test('a non-admin cannot delete', async () => {
    mockUser = { id: 'm1', role: 'manager', organization_id: ORG_A };
    const res = await request(app()).delete(`/api/clients/${CLIENT_ID}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /clients/:id/attendance', () => {
  test('resolves the client from pt_clients and returns logs', async () => {
    const res = await request(app()).get(`/api/clients/${CLIENT_ID}/attendance`);

    expect(res.status).toBe(200);
    expect(wrote(/FROM attendance_logs/i)).toBe(true);
    for (const s of sqls()) expect(s).not.toMatch(/\b(FROM|UPDATE|INTO) clients\b/i);
  });

  test('another studio gets 404 and no log query runs', async () => {
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    mockClient = null;
    const res = await request(app()).get(`/api/clients/${CLIENT_ID}/attendance`);

    expect(res.status).toBe(404);
    expect(wrote(/FROM attendance_logs/i)).toBe(false);
  });
});

describe('GET /clients/:id/payments', () => {
  test('reads pt_payments, never the empty gym ledger', async () => {
    const res = await request(app()).get(`/api/clients/${CLIENT_ID}/payments`);

    expect(res.status).toBe(200);
    expect(wrote(/FROM pt_payments/i)).toBe(true);
    // `payments` is the gym-era table and is empty; reading it returned [] for
    // every client while pt_payments held the real history.
    expect(wrote(/FROM payments\b/i)).toBe(false);
  });

  test('keeps the response field names the client already expects', async () => {
    // pt_payments names these differently; the aliases are the contract.
    await request(app()).get(`/api/clients/${CLIENT_ID}/payments`);

    const q = mockQueries.find((x) => /FROM pt_payments/i.test(x.sql));
    expect(q.sql).toMatch(/payment_method AS method/i);
    expect(q.sql).toMatch(/payment_ref AS receipt_no/i);
    expect(q.sql).toMatch(/deleted_at IS NULL/i);
  });

  test('another studio gets 404 and no payment query runs', async () => {
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    mockClient = null;
    const res = await request(app()).get(`/api/clients/${CLIENT_ID}/payments`);

    expect(res.status).toBe(404);
    expect(wrote(/FROM pt_payments/i)).toBe(false);
  });
});
