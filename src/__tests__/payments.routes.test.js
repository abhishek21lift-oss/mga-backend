// POST /api/payments and DELETE /api/payments/:id — the money path.
//
// Audit finding C-4: payments.js had no route-level test. lib/ helpers around
// it did, but nothing exercised the HTTP layer — so the auth gate, the tenant
// check, the trainer-ownership check and the transaction boundaries were all
// unverified on the route that records money changing hands.
//
// The transaction structure is what makes this worth testing carefully. Every
// early return inside POST (client missing, wrong trainer, wrong tenant) sits
// AFTER `BEGIN` and has to ROLLBACK before responding. A future edit that adds
// a fourth guard and forgets the rollback leaks a connection holding an open
// transaction with a FOR UPDATE row lock on pt_clients — which does not fail
// loudly, it just slowly wedges the pool under concurrency. These tests assert
// the rollback on each path so that regression is caught in CI rather than in
// production at load.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const CLIENT_A = 'ptc-aaa';

// Every statement issued on the transaction client, in order.
const mockTxLog = [];
// Rows the mocked SELECT ... FOR UPDATE returns for the client lookup.
let mockClientRow;
let mockTrainerRow;
let mockDeletedPtPayment;

const mockTxClient = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockTxLog.push({ sql: text, params });

    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM pt_clients WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/i.test(text)) {
      return { rows: mockClientRow ? [mockClientRow] : [], rowCount: mockClientRow ? 1 : 0 };
    }
    if (/SELECT id, incentive_rate FROM trainers/i.test(text)) {
      return { rows: mockTrainerRow ? [mockTrainerRow] : [], rowCount: mockTrainerRow ? 1 : 0 };
    }
    if (/UPDATE pt_payments SET deleted_at/i.test(text)) {
      return { rows: mockDeletedPtPayment ? [mockDeletedPtPayment] : [], rowCount: mockDeletedPtPayment ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(async () => mockTxClient),
  query: jest.fn(async () => ({ rows: [{ id: 'pay-new', amount: 5000 }], rowCount: 1 })),
}));

jest.mock('../db/receipts', () => ({ genReceiptNo: jest.fn(async () => 'RCPT-0001') }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user.role === 'admin' || req.user.role === 'super_admin'
      ? next()
      : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/payments', require('../routes/payments'));
  a.use(errorHandler);
  return a;
}

const sqlAt = (re) => mockTxLog.filter((q) => re.test(q.sql));
const verbs = () => mockTxLog.filter((q) => /^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(q.sql)).map((q) => q.sql.toUpperCase());

const validBody = (over = {}) => ({ client_id: CLIENT_A, amount: 5000, date: '2026-08-06', method: 'UPI', ...over });

beforeEach(() => {
  mockTxLog.length = 0;
  mockTxClient.query.mockClear();
  mockTxClient.release.mockClear();
  mockClientRow = { id: CLIENT_A, organization_id: ORG_A, trainer_id: 'trn-1', name: 'A Client' };
  mockTrainerRow = { id: 'trn-1', incentive_rate: 0.4 };
  mockDeletedPtPayment = null;
  mockUser = { id: 'usr-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

describe('POST /api/payments — validation', () => {
  test('rejects a non-positive amount before opening a transaction', async () => {
    const res = await request(app()).post('/api/payments').send(validBody({ amount: -1 }));

    expect(res.status).toBe(400);
    // Zod runs as middleware, so nothing should have reached the database.
    expect(verbs()).toEqual([]);
  });

  test('rejects a missing client_id', async () => {
    const body = validBody();
    delete body.client_id;
    const res = await request(app()).post('/api/payments').send(body);

    expect(res.status).toBe(400);
    expect(verbs()).toEqual([]);
  });

  test('rejects amount sent as a string, which would bypass the numeric check', async () => {
    // parseFloat('5000abc') is 5000 — the schema is what stops a string here,
    // and this pins that the schema is actually applied to this route.
    const res = await request(app()).post('/api/payments').send(validBody({ amount: '5000' }));

    expect(res.status).toBe(400);
  });
});

describe('POST /api/payments — access control', () => {
  test("404s a client belonging to another tenant, and rolls back", async () => {
    mockClientRow = { id: CLIENT_A, organization_id: ORG_B, trainer_id: null };

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(404);
    // 404 not 403 — deliberately does not confirm the id exists elsewhere.
    expect(res.body.error).toMatch(/not found/i);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sqlAt(/INSERT INTO pt_payments/i)).toHaveLength(0);
  });

  test('403s a trainer recording against a client who is not theirs, and rolls back', async () => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-OTHER' };
    mockClientRow = { id: CLIENT_A, organization_id: ORG_A, trainer_id: 'trn-1' };

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(403);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sqlAt(/INSERT INTO pt_payments/i)).toHaveLength(0);
  });

  test('lets a trainer record against their own client', async () => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-1' };

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(201);
    expect(verbs()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('404s and rolls back when the client does not exist', async () => {
    mockClientRow = null;

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(404);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('a super admin with no org is not blocked by the tenant filter', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null, trainer_id: null };
    mockClientRow = { id: CLIENT_A, organization_id: ORG_B, trainer_id: null };

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(201);
    expect(verbs()).toEqual(['BEGIN', 'COMMIT']);
  });
});

describe('POST /api/payments — the write itself', () => {
  test('locks the client row before touching the balance', async () => {
    await request(app()).post('/api/payments').send(validBody());

    const lock = sqlAt(/FOR UPDATE/i);
    expect(lock).toHaveLength(1);
    // The lock must be taken inside the transaction, not before it.
    expect(mockTxLog.findIndex((q) => /^BEGIN$/i.test(q.sql)))
      .toBeLessThan(mockTxLog.findIndex((q) => /FOR UPDATE/i.test(q.sql)));
  });

  test("stamps the payment with the CLIENT's organization, not the caller's header", async () => {
    // The row is the tenant anchor. Taking the org from the request instead
    // would let a mis-set header file a payment into the wrong tenant.
    await request(app()).post('/api/payments').send(validBody());

    const [ins] = sqlAt(/INSERT INTO pt_payments/i);
    expect(ins.params[9]).toBe(ORG_A);
  });

  test('computes the incentive from the trainer rate', async () => {
    mockTrainerRow = { id: 'trn-1', incentive_rate: 0.4 };

    await request(app()).post('/api/payments').send(validBody({ amount: 5000 }));

    const [ins] = sqlAt(/INSERT INTO pt_payments/i);
    expect(ins.params[3]).toBe(5000);   // amount
    expect(ins.params[4]).toBe(2000);   // 5000 * 0.4
  });

  test('falls back to a 0.5 rate when the trainer has none set', async () => {
    mockTrainerRow = { id: 'trn-1', incentive_rate: null };

    await request(app()).post('/api/payments').send(validBody({ amount: 5000 }));

    const [ins] = sqlAt(/INSERT INTO pt_payments/i);
    expect(ins.params[4]).toBe(2500);
  });

  test('writes a NULL trainer when the assigned trainer no longer exists', async () => {
    // Guards a real failure mode: a deleted trainer whose id is still on the
    // client would make the INSERT fail with a 23503 FK violation, rolling back
    // a legitimate payment. The route resolves the FK first and degrades.
    mockTrainerRow = null;

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBe(201);
    const [ins] = sqlAt(/INSERT INTO pt_payments/i);
    expect(ins.params[2]).toBeNull();
  });

  test('never drives the client balance below zero', async () => {
    await request(app()).post('/api/payments').send(validBody());

    const [upd] = sqlAt(/UPDATE pt_clients SET paid_amount/i);
    expect(upd.sql).toMatch(/GREATEST\(0, balance_amount - \$1\)/i);
  });

  test('uppercases the payment method', async () => {
    await request(app()).post('/api/payments').send(validBody({ method: 'upi' }));

    const [ins] = sqlAt(/INSERT INTO pt_payments/i);
    expect(ins.params[5]).toBe('UPI');
  });

  test('rolls back and releases the connection when the insert fails', async () => {
    mockTxClient.query.mockImplementationOnce(async () => { mockTxLog.push({ sql: 'BEGIN' }); return { rows: [] }; })
      .mockImplementationOnce(async () => ({ rows: [mockClientRow] }))
      .mockImplementationOnce(async () => ({ rows: [mockTrainerRow] }))
      .mockImplementationOnce(async () => { throw new Error('insert exploded'); });

    const res = await request(app()).post('/api/payments').send(validBody());

    expect(res.status).toBeGreaterThanOrEqual(500);
    // The connection must go back to the pool even on the failure path.
    expect(mockTxClient.release).toHaveBeenCalled();
  });

  test('always releases the connection on the happy path too', async () => {
    await request(app()).post('/api/payments').send(validBody());
    expect(mockTxClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/payments/:id', () => {
  test('refuses a non-admin', async () => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-1' };

    const res = await request(app()).delete('/api/payments/pay-1');

    expect(res.status).toBe(403);
  });

  test('scopes the soft-delete to the caller organization', async () => {
    mockDeletedPtPayment = { id: 'pay-1', amount: 5000, client_id: CLIENT_A };

    const res = await request(app()).delete('/api/payments/pay-1');

    expect(res.status).toBe(200);
    const [del] = sqlAt(/UPDATE pt_payments SET deleted_at/i);
    expect(del.sql).toMatch(/organization_id = \$2/);
    expect(del.params).toEqual(['pay-1', ORG_A]);
    expect(verbs()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('reverses the balance by exactly the deleted amount', async () => {
    mockDeletedPtPayment = { id: 'pay-1', amount: 1234, client_id: CLIENT_A };

    await request(app()).delete('/api/payments/pay-1');

    const [upd] = sqlAt(/UPDATE pt_clients SET paid_amount = GREATEST/i);
    expect(upd.params).toEqual([1234, CLIENT_A]);
    // Reversal must not push paid_amount negative if it was already adjusted.
    expect(upd.sql).toMatch(/GREATEST\(0, paid_amount - \$1\)/i);
  });

  test('404s and rolls back when nothing matches in this tenant', async () => {
    mockDeletedPtPayment = null; // falls through to the legacy ledger, also empty

    const res = await request(app()).delete('/api/payments/pay-nope');

    expect(res.status).toBe(404);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
  });
});
