// PATCH /api/pt-os/clients/:id — editing a client must not depend on its price.
//
// Reported as "Save Changes does nothing". It did something: it returned 400
// with "Final Selling Price must be greater than zero." for any client whose
// final_amount is zero or unset, no matter which field was actually edited.
//
// The edit form posts the whole form every time, so changing a phone number
// re-submits final_amount along with it. The handler treated `!== undefined`
// as "the user is setting a price" and then required that price to be > 0 —
// a rule that belongs to enrollment, where a package must cost something, and
// not to an edit that never touched the field.
//
// Two ways in, both real:
//   final_amount 0     → form shows "0.00" → sends 0    → Number(0) = 0
//   final_amount NULL  → form shows ""     → sends null → Number(null) = 0
// Both land on `<= 0` and 400. A complimentary or trial client, or one whose
// price was never filled in, simply could not be edited at all.
'use strict';

const queries = [];
let mockExistingRow = { final_amount: '0', paid_amount: '0' };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    // The pre-check SELECT that reads the current amounts.
    if (/SELECT final_amount, paid_amount FROM pt_clients/i.test(sql)) {
      return { rows: mockExistingRow ? [mockExistingRow] : [], rowCount: mockExistingRow ? 1 : 0 };
    }
    if (/^UPDATE pt_clients/i.test(sql)) {
      return { rows: [{ id: 'c1', name: 'Shailendra Shukla' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
let mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
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
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  return a;
}

/** What the edit form actually posts: every field, every time. */
const fullForm = (over = {}) => ({
  name: 'Shailendra Shukla',
  mobile: '9876543210',
  email: null,
  gender: null,
  dob: null,
  address: null,
  emergency_contact: null,
  emergency_phone: null,
  pt_start_date: null,
  pt_end_date: null,
  duration_months: null,
  final_amount: 0,
  paid_amount: 0,
  ...over,
});

const updateSql = () => queries.find((q) => /^UPDATE pt_clients/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockExistingRow = { final_amount: '0', paid_amount: '0' };
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('PATCH /pt-os/clients/:id with a zero price', () => {
  test('saves a name change on a client whose final_amount is 0', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ name: 'Shailendra S Shukla' }));

    expect(res.status).toBe(200);
    expect(updateSql()).toBeTruthy();
    expect(updateSql().params).toContain('Shailendra S Shukla');
  });

  test('saves when the price was never set at all (null)', async () => {
    // The form renders an unset amount as an empty string and posts null.
    mockExistingRow = { final_amount: null, paid_amount: null };
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ final_amount: null, paid_amount: null, mobile: '9000000000' }));

    expect(res.status).toBe(200);
    expect(updateSql().params).toContain('9000000000');
  });

  test('zero is a price a client may legitimately have', async () => {
    // Complimentary, trial, or a founding member. Nothing about the data model
    // says a package must cost something.
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ final_amount: 0, paid_amount: 0 }));
    expect(res.status).toBe(200);
  });
});

describe('the validation that still has to hold', () => {
  test('a negative price is refused', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ final_amount: -100 }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/negative|greater than/i);
  });

  test('a negative amount paid is refused', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ paid_amount: -1 }));
    expect(res.status).toBe(400);
  });

  test('paid may not exceed final', async () => {
    // The rule that actually protects the ledger, and the reason the pre-check
    // SELECT exists. Loosening the zero check must not loosen this.
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ final_amount: 5000, paid_amount: 6000 }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exceed/i);
  });

  test('paid is still checked against the stored final when only paid changes', async () => {
    mockExistingRow = { final_amount: '1000', paid_amount: '0' };
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send({ paid_amount: 2000 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exceed/i);
  });

  test('a non-numeric price is refused rather than coerced', async () => {
    const res = await request(app())
      .patch('/api/pt-os/clients/c1')
      .send(fullForm({ final_amount: 'abc' }));
    expect(res.status).toBe(400);
  });

  test('a missing client is a 404, not a silent success', async () => {
    mockExistingRow = null;
    const res = await request(app())
      .patch('/api/pt-os/clients/nope')
      .send(fullForm());
    expect(res.status).toBe(404);
  });
});
