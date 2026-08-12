jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../db/pool');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'a'.repeat(64);

const operationsRouter = require('../modules/operations/operations.routes');

const app = express();
app.use(express.json());
app.use('/api/modules', operationsRouter);

function makeUser(id) {
  return {
    id, name: 'Admin', email: 'admin@619fitness.com', role: 'admin',
    trainer_id: null, member_id: null, branch_id: null, is_active: true, token_version: 0,
  };
}

function tokenFor(id) {
  return jwt.sign({ id, token_version: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function withAuth(req, id) {
  return req.set('Authorization', 'Bearer ' + tokenFor(id));
}

function mockPoolSequence(seq) {
  let i = 0;
  pool.query.mockImplementation(async function() {
    const next = seq[i++] || seq[seq.length - 1];
    if (next && next.__reject) throw next.__reject;
    return next || { rows: [] };
  });
}

describe('GET /api/modules/:moduleKey — no mock fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 503 when module_records table is missing', async () => {
    const err = new Error('relation "module_records" does not exist');
    err.code = '42P01';
    mockPoolSequence([
      { rows: [makeUser('usr-1-a')] },
      { __reject: err },
    ]);
    const res = await withAuth(request(app).get('/api/modules/engagement'), 'usr-1-a');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not migrated/i);
  });

  it('does not return mock records even if the table is missing', async () => {
    const err = new Error('relation "module_records" does not exist');
    err.code = '42P01';
    mockPoolSequence([
      { rows: [makeUser('usr-1-b')] },
      { __reject: err },
    ]);
    const res = await withAuth(request(app).get('/api/modules/retention'), 'usr-1-b');
    expect(res.status).toBe(503);
    expect(Array.isArray(res.body)).toBe(false);
  });
});
