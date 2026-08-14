// PUT /api/settings/feature-flags writes atomically.
//
// Audit finding C-6. This handler used to loop over the submitted keys issuing
// one UPDATE per flag with no transaction around them:
//
//   for (const [key, val] of Object.entries(updates)) {
//     await pool.query('UPDATE feature_flags SET value=$1 ... WHERE key=$2', ...)
//   }
//
// What made it worth fixing is not the loop on its own, it is that PUT
// /permissions — thirty lines earlier in the same file, same class of bulk
// key/value write, same author — already did it correctly with a single
// INSERT ... unnest ... ON CONFLICT. Two contradictory answers to one question
// twenty lines apart means no rule was being applied, so the loop would come
// back. This test is the rule.
//
// The failure it prevents: a dropped connection or constraint error on flag 3
// of 5 committed flags 1-2, never attempted 4-5, and returned one 500 that read
// as "nothing happened" — so the next move was to retry a write that had
// already half-applied. Feature flags gate real functionality; a half-applied
// set is a half-configured product.

'use strict';

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 2 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'admin-1', role: 'admin', organization_id: 'org-1' }; next(); },
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
  a.use('/api/settings', require('../routes/settings'));
  return a;
}

const updates = () => mockQueries.filter((q) => /UPDATE feature_flags/i.test(q.sql));

beforeEach(() => { mockQueries.length = 0; });

describe('PUT /settings/feature-flags', () => {
  test('writes every flag in ONE statement, not one per key', async () => {
    const res = await request(app())
      .put('/api/settings/feature-flags')
      .send({ ai_suite: true, finance: false, attendance: true, whatsapp: false, reports: true });

    expect(res.status).toBe(200);
    // The whole point: five flags, one round trip. A loop would give five.
    expect(updates()).toHaveLength(1);
  });

  test('passes the flags as arrays to a set-based UPDATE', async () => {
    await request(app())
      .put('/api/settings/feature-flags')
      .send({ ai_suite: true, finance: false });

    const [q] = updates();
    expect(q.sql).toMatch(/unnest\(\$1::text\[\], \$2::boolean\[\]\)/i);
    expect(q.params[0]).toEqual(['ai_suite', 'finance']);
    expect(q.params[1]).toEqual([true, false]);
  });

  test('coerces truthy/falsy input to real booleans', async () => {
    // The column is `boolean NOT NULL`, and the old loop wrapped each value in
    // Boolean() individually. The array form has to keep doing that or the
    // driver sends strings and the write fails at the type boundary.
    await request(app())
      .put('/api/settings/feature-flags')
      .send({ a: 'yes', b: 0, c: null, d: 1 });

    const [q] = updates();
    expect(q.params[1]).toEqual([true, false, false, true]);
  });

  test('reports how many rows actually changed, not just success', async () => {
    // Unknown keys match no row and are skipped silently — true of the loop
    // too. Returning the count lets a caller notice a typo instead of reading
    // "updated" and believing it.
    const res = await request(app())
      .put('/api/settings/feature-flags')
      .send({ ai_suite: true, definitely_not_a_flag: true, finance: false });

    expect(res.body).toMatchObject({ updated: 2, requested: 3 });
  });

  test('an empty body touches the database at all', async () => {
    const res = await request(app()).put('/api/settings/feature-flags').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 0 });
    expect(updates()).toHaveLength(0);
  });

  test('still rejects a non-object body', async () => {
    const res = await request(app())
      .put('/api/settings/feature-flags')
      .set('Content-Type', 'application/json')
      .send('"not-an-object"');

    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
});

describe('the sibling handler it was made consistent with', () => {
  test('PUT /permissions is still the single-statement form', async () => {
    // If this ever regresses to a loop, the pair is inconsistent again and the
    // reason this test file exists has been undone from the other side.
    // Real keys — the handler filters the body against PERM_KEYS, so invented
    // ones are dropped and no statement runs at all.
    await request(app())
      .put('/api/settings/permissions')
      .send({ perm_trainer_finance: true, perm_trainer_reports: false });

    // The table name moved, the assertion did not: migration 167 gave each
    // studio its own settings (`organization_settings`, keyed by
    // organization_id + key) because the old global table meant one studio's
    // permission toggles applied to all six — V-06. This test is about the
    // shape of the write, which is unchanged and still the thing worth
    // guarding.
    const writes = mockQueries.filter((q) => /INSERT INTO organization_settings/i.test(q.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/unnest/i);
    // And it is scoped, which the old form could not be.
    expect(writes[0].sql).toMatch(/ON CONFLICT \(organization_id, key\)/);
  });
});
