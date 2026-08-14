// /api/leave — the tenant boundary, exercised at runtime rather than read off
// the source.
//
// V-09 in TENANT_SECURITY_AUDIT.md. Every handler in routes/leave.js addressed
// leave by id or trainer_id alone. The list route pins trainer_id to the
// caller's own record when the caller is a trainer, and there was no equivalent
// branch for admin or manager — so GET /api/leave returned every studio's leave
// requests with trainer name, email and phone attached, and approve/reject
// acted on any row on the platform by id.
//
// ── Why this file is runtime and p0TenantIsolation.orgScope.test.js is static
//
// The static test asserts the predicates exist. It cannot check that they are
// NUMBERED correctly, and this route builds its placeholders with a hand-rolled
// `idx` counter that runs alongside a separate `params` array. Inserting the
// org predicate at the front shifts every subsequent $n, and an off-by-one
// there does not throw at lint or in a source scan — it silently compares
// `status` against an organization id, or drops the LIMIT. The assertion that
// actually catches it is: every placeholder the SQL references must exist in
// the params array, and vice versa.
//
// That check is the point of this file. The IDOR assertions around it are the
// five-step matrix the transformation brief requires.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [] });
    // Trainer-ownership lookups resolve; everything else returns the fixture.
    if (/SELECT 1 FROM trainers WHERE id = \$1 AND organization_id = \$2/i.test(text)) {
      return { rows: mockRows.trainerInOrg ? [{ '?column?': 1 }] : [], rowCount: mockRows.trainerInOrg ? 1 : 0 };
    }
    if (/SELECT id FROM trainers WHERE id = \$1 OR user_id = \$1/i.test(text)) {
      return { rows: [{ id: 'trn-1' }], rowCount: 1 };
    }
    if (/SELECT id FROM leave_requests/i.test(text)) {
      return { rows: mockRows.overlap ? [{ id: 'lv-x' }] : [], rowCount: mockRows.overlap ? 1 : 0 };
    }
    return { rows: mockRows.rows, rowCount: mockRows.rows.length };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/leave', require('../routes/leave'));
  return a;
}

const LEAVE_ROW = {
  id: 'lv-1', trainer_id: 'trn-1', leave_type: 'sick',
  from_date: '2026-01-01', to_date: '2026-01-03', reason: 'flu',
  admin_note: null, status: 'pending', approved_by: null, approved_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: null,
};

beforeEach(() => {
  mockLog.length = 0;
  mockRows = { rows: [LEAVE_ROW], overlap: false, trainerInOrg: true };
  mockUser = { id: 'usr-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

/** Every $n the SQL mentions must have a matching entry in params, and vice versa. */
function assertPlaceholdersAlign({ sql, params }) {
  const used = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  if (!used.length) { expect(params).toEqual([]); return; }
  const max = Math.max(...used);
  // No gaps: $1..$max must all appear, or a param is being passed and ignored.
  for (let i = 1; i <= max; i += 1) {
    expect(used).toContain(i);
  }
  expect(params).toHaveLength(max);
}

const listQuery = () => mockLog.find((q) => /FROM leave_requests lr/i.test(q.sql) && /ORDER BY/i.test(q.sql));

describe('GET /api/leave — list', () => {
  test('filters by the caller organization', async () => {
    await request(app()).get('/api/leave');
    const q = listQuery();
    expect(q.sql).toMatch(/lr\.organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('placeholders stay aligned with no filters', async () => {
    await request(app()).get('/api/leave');
    assertPlaceholdersAlign(listQuery());
  });

  test('placeholders stay aligned with every filter set at once', async () => {
    // The regression the org predicate could have introduced: it consumes $1,
    // so status/trainer_id/from/to and the LIMIT/OFFSET pair must all shift.
    await request(app())
      .get('/api/leave?status=pending&trainer_id=trn-9&from=2026-01-01&to=2026-02-01&limit=10&offset=5');
    const q = listQuery();
    assertPlaceholdersAlign(q);
    expect(q.params[0]).toBe(ORG_A);
    expect(q.params).toContain('pending');
    expect(q.params.slice(-2)).toEqual([10, 5]);
  });

  test('placeholders stay aligned for a trainer, whose own branch adds one more', async () => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-1' };
    await request(app()).get('/api/leave?status=pending');
    assertPlaceholdersAlign(listQuery());
  });

  test('a super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/leave');
    expect(listQuery().sql).not.toMatch(/organization_id/);
  });
});

describe('GET /api/leave/:id — tenant B cannot read tenant A\'s row', () => {
  test('scopes the lookup', async () => {
    await request(app()).get('/api/leave/lv-1');
    const q = mockLog.find((x) => /WHERE lr\.id = \$1/i.test(x.sql));
    expect(q.sql).toMatch(/lr\.organization_id = \$2/);
    expect(q.params).toEqual(['lv-1', ORG_A]);
    assertPlaceholdersAlign(q);
  });

  test('404s when the row belongs to another organization', async () => {
    mockUser = { ...mockUser, organization_id: ORG_B };
    mockRows.rows = []; // the org predicate matched nothing
    const res = await request(app()).get('/api/leave/lv-1');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/leave — create', () => {
  const body = { trainer_id: 'trn-1', leave_type: 'sick', from_date: '2026-01-01', to_date: '2026-01-03' };

  test('rejects a trainer belonging to another organization', async () => {
    mockRows.trainerInOrg = false;
    const res = await request(app()).post('/api/leave').send(body);
    expect(res.status).toBe(404);
    // And nothing was written.
    expect(mockLog.some((q) => /INSERT INTO leave_requests/i.test(q.sql))).toBe(false);
  });

  test('stamps the new row with the caller organization', async () => {
    await request(app()).post('/api/leave').send(body);
    const q = mockLog.find((x) => /INSERT INTO leave_requests/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id/);
    expect(q.params).toContain(ORG_A);
    assertPlaceholdersAlign(q);
  });

  test('scopes the overlap check so a 409 cannot leak a foreign booking', async () => {
    await request(app()).post('/api/leave').send(body);
    const q = mockLog.find((x) => /SELECT id FROM leave_requests/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id = \$5/);
    assertPlaceholdersAlign(q);
  });
});

describe.each([['approve'], ['reject']])('POST /api/leave/:id/%s', (action) => {
  test('cannot act on another organization\'s row', async () => {
    await request(app()).post(`/api/leave/lv-1/${action}`).send({});
    const q = mockLog.find((x) => /UPDATE leave_requests SET status/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id = \$6/);
    expect(q.params[5]).toBe(ORG_A);
    assertPlaceholdersAlign(q);
  });

  test('404s when the predicate matches nothing', async () => {
    mockRows.rows = [];
    const res = await request(app()).post(`/api/leave/lv-1/${action}`).send({});
    expect(res.status).toBe(404);
  });
});
