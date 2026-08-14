// Member check-in — the front-desk path added in Phase 4.
//
// Attendance already worked before this phase; what it could not do was record
// a gym member, because the ref_type CHECK admitted only the four kinds of
// person a PT studio has. These tests pin the two halves of the fix that a
// reader cannot verify by looking at the schema:
//
//   1. member_id and ref_type must agree on every write path, because
//      migration 169 constrains them to. A handler that forgets to populate
//      member_id does not produce a slightly-wrong row — it produces a check
//      constraint violation and a 500 at the turnstile.
//
//   2. A member id arriving in a request body is not evidence of anything.
//      The database now refuses a cross-tenant pair outright, but a 500 from a
//      foreign key is the wrong way to say "not found" — it leaks that the
//      constraint exists and turns a routine typo into an error-tracker page.
//
// The membership lookup is tested for what it REPORTS rather than what it
// blocks, because it deliberately blocks nothing. See the handler's comment:
// an expired membership still records attendance and still returns 201, and
// the person at the desk decides. A test asserting 403 here would be pinning a
// policy this code does not have and should not acquire silently.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = {
      id: 'usr-1', role: 'admin',
      organization_id: '11111111-1111-1111-1111-111111111111',
      trainer_id: null,
    };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({
  requireStaff: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const attendanceRouter = require('../routes/attendance');

const app = express();
app.use(express.json());
// branchScope is applied by the real mount; the routes under test do not read
// it, and supplying a permissive stub keeps this file about attendance rather
// than about middleware wiring.
app.use((req, _res, next) => {
  req.branchScope = { appendTo: (params) => ({ sql: 'TRUE', params }) };
  next();
});
app.use('/api/attendance', attendanceRouter);

/**
 * Route pool.query by what the SQL is asking for.
 *
 * Matching on a distinctive fragment rather than on call order: the handlers
 * short-circuit (a failed org guard never reaches the member SELECT), so an
 * ordered queue silently feeds the wrong rows to whichever query runs first
 * once a branch changes.
 */
function mockDb({ memberInOrg = true, member = null, membership = null, log = null, update = null }) {
  pool.query.mockImplementation((sql) => {
    const q = String(sql);
    // `memberships` BEFORE `members`, and this order is load-bearing rather
    // than stylistic: 'FROM memberships'.includes('FROM members') is true,
    // because members is a prefix of memberships. Matched the other way round,
    // the membership lookup gets answered with a member row and three tests
    // fail describing a bug that only exists in this function.
    if (q.includes('FROM memberships')) return Promise.resolve({ rows: membership ? [membership] : [], rowCount: membership ? 1 : 0 });
    if (q.includes('SELECT 1 FROM members')) {
      return Promise.resolve({ rowCount: memberInOrg ? 1 : 0, rows: memberInOrg ? [{ '?column?': 1 }] : [] });
    }
    if (q.includes('FROM members')) return Promise.resolve({ rows: member ? [member] : [], rowCount: member ? 1 : 0 });
    if (q.includes('INSERT INTO attendance_logs')) {
      return Promise.resolve({ rows: [log || { id: 'att-1', date: '2026-08-14', check_in_time: 'T', first_today: true }], rowCount: 1 });
    }
    if (q.includes('UPDATE attendance_logs')) {
      return Promise.resolve({ rows: update ? [update] : [], rowCount: update ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const MEMBER_A = { id: 'mem-a1', name: 'Asha', member_code: 'M1', status: 'active' };

beforeEach(() => { pool.query.mockReset(); });

describe('POST /api/attendance/check-in', () => {
  test('a foreign member is 404, not a foreign-key 500', async () => {
    // The database refuses this pair outright — verified against a real
    // Postgres, the composite FK rejects studio B's member under studio A's
    // organization_id. That refusal arrives as a 23503 and a 500. This guard
    // is what turns it into the answer the caller should get, and keeps the
    // response identical to a member id that simply does not exist.
    mockDb({ memberInOrg: false });
    const res = await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-b1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Member not found');
    // Nothing was written.
    const wrote = pool.query.mock.calls.some(([s]) => String(s).includes('INSERT INTO attendance_logs'));
    expect(wrote).toBe(false);
  });

  test('member_id is required', async () => {
    mockDb({});
    const res = await request(app).post('/api/attendance/check-in').send({});
    expect(res.status).toBe(400);
  });

  test('writes ref_type member AND member_id, which migration 169 requires to agree', async () => {
    mockDb({ member: MEMBER_A, membership: null });
    const res = await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(201);

    const insert = pool.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO attendance_logs'));
    expect(insert[0]).toMatch(/'member'/);
    // $2 is bound to both ref_id and member_id in the VALUES list, which is
    // what keeps the polymorphic column and the foreign key from drifting.
    expect(insert[0]).toMatch(/VALUES\s*\(\$1,\$2,'member',\$3,\$2,/);
    expect(insert[1]).toContain('mem-a1');
    expect(insert[1]).toContain(ORG_A);
  });

  test('an active membership reports grants_entry', async () => {
    mockDb({
      member: MEMBER_A,
      membership: {
        id: 'ms-1', plan_name: 'Monthly', status: 'active',
        ends_on: '2026-09-10', days_remaining: 27, grants_entry: true,
      },
    });
    const res = await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(201);
    expect(res.body.data.membership.grants_entry).toBe(true);
    expect(res.body.data.membership.days_remaining).toBe(27);
    expect(res.body.data.member.name).toBe('Asha');
  });

  test('an EXPIRED membership still records the visit and still returns 201', async () => {
    // The deliberate product decision, pinned so it cannot be "fixed" into a
    // 403 by someone who reads a lapsed membership as an error. A member who
    // paid in cash a minute ago, whose renewal is still being keyed in, is
    // exactly who a hard block turns away.
    mockDb({
      member: MEMBER_A,
      membership: {
        id: 'ms-1', plan_name: 'Monthly', status: 'expired',
        ends_on: '2026-07-01', days_remaining: -44, grants_entry: false,
      },
    });
    const res = await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(201);
    expect(res.body.data.membership.grants_entry).toBe(false);
    expect(res.body.data.attendance).toBeTruthy();
  });

  test('no membership at all is null, not a missing key', async () => {
    // A day-pass visitor, or someone registered but not yet sold anything.
    // `undefined` would drop out of the JSON entirely and the desk would have
    // no way to tell it apart from a field the API forgot to send.
    mockDb({ member: MEMBER_A, membership: null });
    const res = await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('membership');
    expect(res.body.data.membership).toBeNull();
  });

  test('an unrecognised method falls back to manual rather than failing the CHECK', async () => {
    mockDb({ member: MEMBER_A });
    await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1', method: 'telepathy' });
    const insert = pool.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO attendance_logs'));
    expect(insert[1]).toContain('manual');
    expect(insert[1]).not.toContain('telepathy');
  });

  test('the member SELECT carries the org predicate, not just the guard', async () => {
    mockDb({ member: MEMBER_A });
    await request(app).post('/api/attendance/check-in').send({ member_id: 'mem-a1' });
    const select = pool.query.mock.calls.find(
      ([s]) => String(s).includes('FROM members') && !String(s).includes('SELECT 1 FROM members')
    );
    expect(select[0]).toMatch(/organization_id = \$2/);
    expect(select[1]).toContain(ORG_A);
  });
});

describe('POST /api/attendance/check-out', () => {
  test('404 when there is no open check-in today', async () => {
    mockDb({ update: null });
    const res = await request(app).post('/api/attendance/check-out').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(404);
  });

  test('closes the open visit and returns the computed duration', async () => {
    // duration_minutes is set by the BEFORE UPDATE trigger from
    // 025_qr_checkin.sql, so RETURNING sees the computed value rather than the
    // pre-update one. Worth pinning: an AFTER trigger would return stale.
    mockDb({ update: { id: 'att-1', check_in_time: 'T0', check_out_time: 'T1', duration_minutes: 75 } });
    const res = await request(app).post('/api/attendance/check-out').send({ member_id: 'mem-a1' });
    expect(res.status).toBe(200);
    expect(res.body.data.duration_minutes).toBe(75);
  });

  test('a foreign member cannot be checked out either', async () => {
    mockDb({ memberInOrg: false });
    const res = await request(app).post('/api/attendance/check-out').send({ member_id: 'mem-b1' });
    expect(res.status).toBe(404);
    const wrote = pool.query.mock.calls.some(([s]) => String(s).includes('UPDATE attendance_logs'));
    expect(wrote).toBe(false);
  });
});

describe('POST /api/attendance — the general register still works', () => {
  test('type=member populates member_id', async () => {
    mockDb({});
    const res = await request(app).post('/api/attendance')
      .send({ ref_id: 'mem-a1', type: 'member', date: '2026-08-14' });
    expect(res.status).toBe(201);
    const insert = pool.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO attendance_logs'));
    expect(insert[1][12]).toBe('mem-a1');
  });

  test('type=client leaves member_id NULL — the constraint forbids populating it', async () => {
    // Not an oversight to tidy up later. A client row carrying a member_id
    // violates attendance_logs_member_ref_agree, so "helpfully" filling it in
    // for the member a PT client is linked to would fail every PT check-in.
    mockDb({});
    const res = await request(app).post('/api/attendance')
      .send({ ref_id: 'client-x', type: 'client', date: '2026-08-14' });
    expect(res.status).toBe(201);
    const insert = pool.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO attendance_logs'));
    expect(insert[1][12]).toBeNull();
  });

  test('a foreign member is rejected here too', async () => {
    mockDb({ memberInOrg: false });
    const res = await request(app).post('/api/attendance')
      .send({ ref_id: 'mem-b1', type: 'member', date: '2026-08-14' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/attendance/bulk', () => {
  test('one foreign member costs that record, not the batch', async () => {
    // The loop reports per-index errors, so a day's register with a single bad
    // id should still post the rest. Hoisting the guard out of the loop would
    // have made one typo discard two hundred rows.
    pool.query.mockImplementation((sql, params) => {
      const q = String(sql);
      if (q.includes('SELECT 1 FROM members')) {
        return Promise.resolve({ rowCount: params[0] === 'mem-a1' ? 1 : 0, rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/attendance/bulk').send({
      records: [
        { ref_id: 'mem-a1', type: 'member', date: '2026-08-14', status: 'present' },
        { ref_id: 'mem-b1', type: 'member', date: '2026-08-14', status: 'present' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0]).toMatchObject({ index: 1, error: 'Member not found' });
  });
});

describe('GET /api/attendance/today-summary', () => {
  test('defaults to client, so every existing caller keeps its number', async () => {
    pool.query.mockResolvedValue({ rows: [{ present: '3', absent: '0', late: '1', total: '4' }] });
    await request(app).get('/api/attendance/today-summary');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/a\.ref_type = \$\d/);
    expect(params).toContain('client');
  });

  test('type=member counts the gym floor', async () => {
    pool.query.mockResolvedValue({ rows: [{ present: '40', absent: '0', late: '0', total: '40' }] });
    const res = await request(app).get('/api/attendance/today-summary?type=member');
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toContain('member');
  });

  test('a junk type falls back to client rather than reaching the query', async () => {
    pool.query.mockResolvedValue({ rows: [{ present: '0', absent: '0', late: '0', total: '0' }] });
    await request(app).get('/api/attendance/today-summary?type=' + encodeURIComponent("'; DROP TABLE"));
    expect(pool.query.mock.calls[0][1]).toContain('client');
  });
});
