// GET /api/pt-os/trainers — tenant isolation.
//
// This route had no organization filter at all. Every studio saw every trainer
// on the platform: the Book PT Session dialog listed four trainers belonging to
// four different studios, and the payload carried email, mobile, specialization
// and incentive_rate alongside the names — one studio's commission terms,
// readable by its competitors.
//
// Asserted on the SQL rather than only on the returned rows, because a mock can
// be made to return the right thing by accident. If the filter is dropped again,
// the query itself stops carrying organization_id and these fail.
'use strict';

const queries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';

// Impersonates whoever the test needs to be, in place of the real JWT middleware.
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

/** The trainer-list query, whichever of the recorded statements it is. */
function trainerQuery() {
  return queries.find((q) => /FROM trainers/i.test(q.sql) && /UNION/i.test(q.sql));
}

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('GET /pt-os/trainers tenant isolation', () => {
  test('filters BOTH tables by the caller organization', async () => {
    await request(app()).get('/api/pt-os/trainers');
    const q = trainerQuery();

    expect(q).toBeTruthy();
    // Once for `trainers`, once for `pt_trainers` — a filter on only one half
    // of the UNION still leaks the other half.
    expect(q.sql.match(/organization_id = \$1/g)).toHaveLength(2);
    expect(q.params).toEqual([ORG_A]);
  });

  test('a trainer from another studio cannot be reached by asking', async () => {
    // There is no parameter a caller can set to widen the scope: the org comes
    // from the authenticated user, never from the request.
    await request(app()).get('/api/pt-os/trainers?organization_id=22222222-2222-2222-2222-222222222222');
    expect(trainerQuery().params).toEqual([ORG_A]);
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/pt-os/trainers');
    const q = trainerQuery();
    expect(q.sql).not.toMatch(/organization_id = \$/);
    expect(q.params).toEqual([]);
  });

  test('a super admin targeting one studio IS filtered to it', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app())
      .get('/api/pt-os/trainers')
      .set('x-org-id', ORG_A);
    expect(trainerQuery().params).toEqual([ORG_A]);
  });

  test('creating a trainer stamps the organization, or it would be invisible to its own studio', async () => {
    await request(app()).post('/api/pt-os/trainers').send({ name: 'New Coach' });
    const insert = queries.find((q) => /INSERT INTO trainers/i.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert.sql).toMatch(/organization_id/);
    expect(insert.params).toContain(ORG_A);
  });
});
