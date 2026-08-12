// /api/invoices — creation, mark-paid, and the tenant boundary.
//
// Audit finding C-4: invoices.js had no route-level test.
//
// Writing them surfaced a real gap, now fixed and pinned below. POST / looked
// the client up with
//
//     SELECT id, name FROM pt_clients WHERE id=$1 AND deleted_at IS NULL
//
// and no organization predicate — while payments.js and this same file's
// mark-paid handler both scope the equivalent lookup. So a caller could pass
// another studio's client id, have the invoice stamped with their OWN org via
// orgIdOf(req), and read that client's name back in the 201 response. A
// cross-tenant disclosure produced by an inconsistency between two sibling
// handlers rather than by a missing concept.
//
// That is also the shape of bug the tenantScope convention test cannot catch:
// invoices.js references tenantScope on five other routes, so file-level
// awareness was never in question. Only a route-level test reaches it.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockTxLog = [];
let mockClientRow;
let mockInvoiceRow;

const mockTxClient = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockTxLog.push({ sql: text, params });

    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT id, name FROM pt_clients/i.test(text)) {
      return { rows: mockClientRow ? [mockClientRow] : [], rowCount: mockClientRow ? 1 : 0 };
    }
    if (/UPDATE invoices SET status='paid'/i.test(text)) {
      return { rows: mockInvoiceRow ? [mockInvoiceRow] : [], rowCount: mockInvoiceRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(async () => mockTxClient),
  query: jest.fn(async () => ({ rows: [{ id: 'inv-new' }], rowCount: 1 })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/invoices', require('../routes/invoices'));
  a.use(errorHandler);
  return a;
}

const sqlAt = (re) => mockTxLog.filter((q) => re.test(q.sql));
const verbs = () => mockTxLog.filter((q) => /^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(q.sql)).map((q) => q.sql.toUpperCase());
const clientLookup = () => sqlAt(/SELECT id, name FROM pt_clients/i)[0];

beforeEach(() => {
  mockTxLog.length = 0;
  mockTxClient.query.mockClear();
  mockTxClient.release.mockClear();
  mockClientRow = { id: 'ptc-1', name: 'A Client' };
  mockInvoiceRow = null;
  mockUser = { id: 'usr-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

describe('POST /api/invoices — tenant boundary on the client lookup', () => {
  test('scopes the client lookup to the caller organization', async () => {
    await request(app()).post('/api/invoices')
      .send({ client_id: 'ptc-1', items: [{ description: 'PT block', unit_price: 5000, quantity: 1 }] });

    const q = clientLookup();
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params).toEqual(['ptc-1', ORG_A]);
  });

  test("404s and rolls back when the client is another tenant's", async () => {
    // The org predicate is in the SQL, so a cross-tenant id returns no row.
    mockClientRow = null;

    const res = await request(app()).post('/api/invoices')
      .send({ client_id: 'ptc-of-org-b', items: [{ description: 'x', unit_price: 1, quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sqlAt(/INSERT INTO invoices/i)).toHaveLength(0);
  });

  test('a super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null, trainer_id: null };

    await request(app()).post('/api/invoices')
      .send({ client_id: 'ptc-1', items: [{ description: 'x', unit_price: 1, quantity: 1 }] });

    const q = clientLookup();
    expect(q.sql).not.toMatch(/organization_id/);
    expect(q.params).toEqual(['ptc-1']);
  });

  test('a super admin targeting one org via x-org-id IS filtered to it', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null, trainer_id: null };

    await request(app()).post('/api/invoices')
      .set('x-org-id', ORG_B)
      .send({ client_id: 'ptc-1', items: [{ description: 'x', unit_price: 1, quantity: 1 }] });

    const q = clientLookup();
    expect(q.params).toEqual(['ptc-1', ORG_B]);
  });
});

describe('POST /api/invoices — totals and shape', () => {
  const create = (body) => request(app()).post('/api/invoices').send(body);

  test('rejects a body with neither client_id/items nor the simplified fields', async () => {
    const res = await create({});

    expect(res.status).toBe(400);
    // Rejected before the transaction opens.
    expect(verbs()).toEqual([]);
  });

  test('sums line items and applies tax to the subtotal', async () => {
    await create({
      client_id: 'ptc-1',
      tax_pct: 18,
      items: [
        { description: 'PT block', unit_price: 5000, quantity: 2 },
        { description: 'Assessment', unit_price: 1000, quantity: 1 },
      ],
    });

    const [ins] = sqlAt(/INSERT INTO invoices/i);
    expect(ins.params[4]).toBe(11000);            // subtotal 5000*2 + 1000
    expect(ins.params[5]).toBeCloseTo(1980, 5);   // 18% of 11000
    expect(ins.params[6]).toBeCloseTo(12980, 5);  // total
  });

  test('defaults a missing quantity to 1 rather than dropping the line', async () => {
    await create({ client_id: 'ptc-1', items: [{ description: 'PT block', unit_price: 2500 }] });

    const [ins] = sqlAt(/INSERT INTO invoices/i);
    expect(ins.params[4]).toBe(2500);
  });

  test('writes one invoice_items row per line', async () => {
    await create({
      client_id: 'ptc-1',
      items: [
        { description: 'a', unit_price: 100, quantity: 1 },
        { description: 'b', unit_price: 200, quantity: 3 },
      ],
    });

    const items = sqlAt(/INSERT INTO invoice_items/i);
    expect(items).toHaveLength(2);
    expect(items[1].params[5]).toBe(600); // 200 * 3
  });

  test('stamps the invoice with the caller organization', async () => {
    await create({ client_id: 'ptc-1', items: [{ description: 'x', unit_price: 1, quantity: 1 }] });

    const [ins] = sqlAt(/INSERT INTO invoices/i);
    expect(ins.params[13]).toBe(ORG_A);
  });

  test('the simplified form skips the client lookup entirely', async () => {
    // The frontend sends {member_name, amount, description} for ad-hoc
    // invoices with no client record. That path must not 404 on a missing
    // client_id — but it also must not silently invent one.
    const res = await create({ member_name: 'Walk-in', amount: 1500, description: 'Day pass' });

    expect(res.status).toBe(201);
    expect(sqlAt(/SELECT id, name FROM pt_clients/i)).toHaveLength(0);
    const [ins] = sqlAt(/INSERT INTO invoices/i);
    expect(ins.params[2]).toBeNull();      // client_id
    expect(ins.params[3]).toBe('Walk-in'); // client_name
    expect(ins.params[4]).toBe(1500);
  });

  test('releases the connection on the happy path', async () => {
    await create({ client_id: 'ptc-1', items: [{ description: 'x', unit_price: 1, quantity: 1 }] });
    expect(mockTxClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/invoices/:id/mark-paid', () => {
  test('scopes the update to the caller organization', async () => {
    mockInvoiceRow = { id: 'inv-1', invoice_no: 'INV-1', client_id: 'ptc-1', client_name: 'A', total_amount: 5000 };

    const res = await request(app()).post('/api/invoices/inv-1/mark-paid').send({});

    expect(res.status).toBe(200);
    const [upd] = sqlAt(/UPDATE invoices SET status='paid'/i);
    expect(upd.sql).toMatch(/organization_id = \$2/);
    expect(upd.params).toEqual(['inv-1', ORG_A]);
  });

  test('only transitions an invoice out of an unpaid state', async () => {
    mockInvoiceRow = { id: 'inv-1', invoice_no: 'INV-1', client_id: 'ptc-1', client_name: 'A', total_amount: 1 };

    await request(app()).post('/api/invoices/inv-1/mark-paid').send({});

    const [upd] = sqlAt(/UPDATE invoices SET status='paid'/i);
    // Guards double-payment: a row already 'paid' matches nothing and 404s.
    expect(upd.sql).toMatch(/status IN \('sent','draft','partial','overdue'\)/);
  });

  test('404s and rolls back when the invoice is already paid or not this tenant', async () => {
    mockInvoiceRow = null;

    const res = await request(app()).post('/api/invoices/inv-1/mark-paid').send({});

    expect(res.status).toBe(404);
    expect(verbs()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sqlAt(/UPDATE pt_clients/i)).toHaveLength(0);
  });

  test('credits the client balance by the invoice total, floored at zero', async () => {
    mockInvoiceRow = { id: 'inv-1', invoice_no: 'INV-1', client_id: 'ptc-9', client_name: 'A', total_amount: 3200 };

    await request(app()).post('/api/invoices/inv-1/mark-paid').send({});

    const [upd] = sqlAt(/UPDATE pt_clients/i);
    expect(upd.params).toEqual([3200, 'ptc-9']);
    expect(upd.sql).toMatch(/GREATEST\(0, COALESCE\(balance_amount, 0\) - \$1\)/i);
    expect(verbs()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('does not touch a client balance for a client-less invoice', async () => {
    // Simplified/ad-hoc invoices carry no client_id; the balance update has to
    // be skipped rather than run with a null id.
    mockInvoiceRow = { id: 'inv-1', invoice_no: 'INV-1', client_id: null, client_name: 'Walk-in', total_amount: 500 };

    const res = await request(app()).post('/api/invoices/inv-1/mark-paid').send({});

    expect(res.status).toBe(200);
    expect(sqlAt(/UPDATE pt_clients/i)).toHaveLength(0);
  });
});
