// /api/members — the Phase 2 member domain, and its tenant boundary.
//
// The five-step matrix the transformation brief requires, per verb:
//
//     Tenant A creates → A reads it → B cannot read → B cannot update →
//     B cannot delete
//
// This route is the one place in the codebase where getting tenancy wrong has
// the most history behind it. Its predecessor, /api/v1/members, was deleted
// precisely because list() had no organization predicate for admin or manager
// — see MEMBERS-TENANT-GAP.md and membersEndpointRemoved.test.js, which still
// guards that path. So the assertions here are deliberately about the SQL that
// reaches the database, not just about status codes: a 404 can come from an
// empty fixture as easily as from a working predicate, and only one of those
// is the thing being tested.
//
// Member-code allocation is covered separately at the bottom. All three of the
// defects MEMBERS-TENANT-GAP.md records about the deleted generator are
// assertable from the SQL and the connection handling, and all three are
// regressions that would look completely fine in review.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

const mockTxClient = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [], tx: true });
    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [{}], rowCount: 1 };
    if (/MAX\(CAST\(SUBSTRING\(member_code/i.test(text)) {
      return { rows: [{ max_n: mockRows.maxCode }], rowCount: 1 };
    }
    if (/INSERT INTO members/i.test(text)) {
      if (mockRows.insertError) throw mockRows.insertError;
      return { rows: [{ id: 'mem-new', member_code: 'M00042' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(async () => mockTxClient),
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [], tx: false });
    if (/count\(\*\)::int AS total/i.test(text)) return { rows: [{ total: mockRows.rows.length }], rowCount: 1 };
    if (/count\(\*\)::int AS count FROM pt_clients/i.test(text)) {
      return { rows: [{ count: mockRows.ptEnrollments }], rowCount: 1 };
    }
    if (/FROM pt_clients/i.test(text)) return { rows: [], rowCount: 0 };
    return { rows: mockRows.rows, rowCount: mockRows.rows.length };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/members', require('../routes/members'));
  return a;
}

const MEMBER = {
  id: 'mem-1', organization_id: ORG_A, member_code: 'M00001', name: 'Asha Rao',
  mobile: '9990001111', email: null, dob: null, gender: null, address: null,
  photo_url: null, emergency_contact: null, emergency_phone: null,
  status: 'active', joined_on: null, source: 'walk-in', notes: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: null,
};

beforeEach(() => {
  mockLog.length = 0;
  mockTxClient.query.mockClear();
  mockTxClient.release.mockClear();
  mockRows = { rows: [MEMBER], maxCode: 41, ptEnrollments: 0, insertError: null };
  mockUser = { id: 'usr-a', role: 'admin', organization_id: ORG_A };
});

const find = (re) => mockLog.find((q) => re.test(q.sql));
const asTenantB = () => { mockUser = { id: 'usr-b', role: 'admin', organization_id: ORG_B }; mockRows.rows = []; };

describe('GET /api/members — list', () => {
  test('filters by the caller organization', async () => {
    await request(app()).get('/api/members');
    const q = find(/SELECT .* FROM members WHERE/i);
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('the org predicate is not conditional on any query filter', async () => {
    // The exact defect that killed the v1 endpoint: its WHERE was assembled
    // from optional filters, so the unfiltered request produced no predicate at
    // all. Here the org filter must be present with and without filters.
    await request(app()).get('/api/members');
    expect(find(/SELECT .* FROM members WHERE/i).sql).toMatch(/organization_id/);
    mockLog.length = 0;
    await request(app()).get('/api/members?status=active&search=asha&source=lead');
    expect(find(/SELECT .* FROM members WHERE/i).sql).toMatch(/organization_id/);
  });

  test('the count query carries the same predicate as the page query', async () => {
    // A total computed without the tenant filter leaks the platform-wide row
    // count even when the page itself is scoped.
    await request(app()).get('/api/members?status=active');
    const count = find(/count\(\*\)::int AS total/i);
    expect(count.sql).toMatch(/organization_id/);
    expect(count.params).toContain(ORG_A);
  });

  test('placeholders align in the count query after limit/offset are dropped', async () => {
    // countParams slices the last two off. If the org predicate were appended
    // after limit/offset instead of before, that slice would remove it.
    await request(app()).get('/api/members?status=active&search=x&limit=10&offset=5');
    const count = find(/count\(\*\)::int AS total/i);
    const used = [...count.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(count.params).toHaveLength(Math.max(...used));
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/members');
    // Asserted on the WHERE clause, not the whole statement: organization_id is
    // one of the selected columns, so a naive match on the full SQL passes
    // whatever the predicate does.
    const where = find(/SELECT .* FROM members WHERE/i).sql.split(/ WHERE /i)[1];
    expect(where).not.toMatch(/organization_id/);
  });
});

describe('GET /api/members/:id — tenant B cannot read tenant A\'s member', () => {
  test('A reads its own member, and gets the PT enrollment list', async () => {
    const res = await request(app()).get('/api/members/mem-1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('mem-1');
    // A member with no PT is a normal gym member, not an error. This is the
    // whole point of Phase 2 and is asserted rather than assumed.
    expect(res.body.data.pt_enrollments).toEqual([]);
  });

  test('the lookup is scoped', async () => {
    await request(app()).get('/api/members/mem-1');
    const q = find(/FROM members WHERE id = \$1/i);
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params).toEqual(['mem-1', ORG_A]);
  });

  test('the enrollment query is scoped too, not just the parent lookup', async () => {
    await request(app()).get('/api/members/mem-1');
    const q = find(/FROM pt_clients WHERE member_id/i);
    expect(q.sql).toMatch(/organization_id/);
    expect(q.params).toContain(ORG_A);
  });

  test('B gets 404', async () => {
    asTenantB();
    const res = await request(app()).get('/api/members/mem-1');
    expect(res.status).toBe(404);
    expect(find(/FROM members WHERE id = \$1/i).params).toEqual(['mem-1', ORG_B]);
  });
});

describe('POST /api/members — create', () => {
  const body = { name: 'New Member', mobile: '9998887777' };

  test('stamps the caller organization', async () => {
    const res = await request(app()).post('/api/members').send(body);
    expect(res.status).toBe(201);
    const q = find(/INSERT INTO members/i);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('refuses when the caller has no organization to own the row', async () => {
    // Otherwise the row is created org-less: invisible to every studio, present
    // in the table, reported as success. That is the silent data loss
    // 155_organization_id_not_null.sql exists to prevent.
    //
    // An `admin` with no organization, not a super_admin: super_admin is not in
    // canWrite, so requireRole refuses it at 403 and never reaches this branch.
    // The reachable case is a tenant user whose organization_id failed to
    // resolve, which is exactly what tenant-db.js's fail-closed rule produces.
    mockUser = { id: 'usr-orgless', role: 'admin', organization_id: null };
    const res = await request(app()).post('/api/members').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORG_REQUIRED');
    expect(find(/INSERT INTO members/i)).toBeUndefined();
  });

  test('a duplicate mobile in the same studio is a 409, not a 500', async () => {
    const err = new Error('duplicate key'); err.code = '23505'; err.constraint = 'uq_members_org_mobile';
    mockRows.insertError = err;
    const res = await request(app()).post('/api/members').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOBILE_EXISTS');
    // And the transaction was rolled back, not left open.
    expect(mockLog.filter((q) => /^ROLLBACK/i.test(q.sql))).toHaveLength(1);
    expect(mockTxClient.release).toHaveBeenCalled();
  });

  test('a caller cannot choose their own member_code', async () => {
    // Accepting one reintroduces exactly the collision the generator prevents.
    await request(app()).post('/api/members').send({ ...body, member_code: 'M99999' });
    const q = find(/INSERT INTO members/i);
    expect(q.params).not.toContain('M99999');
  });

  test('trainers cannot create members', async () => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A };
    const res = await request(app()).post('/api/members').send(body);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/members/:id — tenant B cannot update', () => {
  test('the predicate is in the UPDATE\'s own WHERE', async () => {
    await request(app()).put('/api/members/mem-1').send({ name: 'Renamed' });
    const q = find(/^UPDATE members SET/i);
    expect(q.sql).toMatch(/WHERE id = \$1 AND deleted_at IS NULL AND organization_id = \$\d+/);
    expect(q.params).toContain(ORG_A);
  });

  test('B gets 404 and its own org id reaches the query', async () => {
    asTenantB();
    const res = await request(app()).put('/api/members/mem-1').send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(find(/^UPDATE members SET/i).params).toContain(ORG_B);
  });

  test('rejects an empty patch rather than writing updated_at alone', async () => {
    const res = await request(app()).put('/api/members/mem-1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FIELDS');
  });
});

describe('DELETE /api/members/:id — tenant B cannot delete', () => {
  test('soft-deletes within the caller organization', async () => {
    mockRows.rows = [{ id: 'mem-1' }];
    const res = await request(app()).delete('/api/members/mem-1');
    expect(res.status).toBe(200);
    const q = find(/UPDATE members SET deleted_at/i);
    expect(q.sql).toMatch(/organization_id = \$\d+/);
    expect(q.params).toContain(ORG_A);
  });

  test('refuses while PT enrollments are attached', async () => {
    // pt_clients.member_id is ON DELETE RESTRICT, but a soft delete does not go
    // through that constraint. Without this check the member disappears from
    // the roster while their payments, sessions and assessments stay live and
    // unreachable.
    mockRows.ptEnrollments = 2;
    const res = await request(app()).delete('/api/members/mem-1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_PT_ENROLLMENT');
    expect(find(/UPDATE members SET deleted_at/i)).toBeUndefined();
  });

  test('the enrollment check is itself scoped', async () => {
    // Unscoped, it would count another studio's enrollments and refuse a
    // legitimate delete — a cross-tenant read leaking through a status code.
    await request(app()).delete('/api/members/mem-1');
    const q = find(/count\(\*\)::int AS count FROM pt_clients/i);
    expect(q.sql).toMatch(/organization_id/);
    expect(q.params).toContain(ORG_A);
  });

  test('B gets 404', async () => {
    asTenantB();
    const res = await request(app()).delete('/api/members/mem-1');
    expect(res.status).toBe(404);
  });

  test('reception cannot delete, only admin and manager', async () => {
    mockUser = { id: 'usr-r', role: 'reception', organization_id: ORG_A };
    const res = await request(app()).delete('/api/members/mem-1');
    expect(res.status).toBe(403);
  });
});

describe('member codes — the three defects MEMBERS-TENANT-GAP.md records', () => {
  test('the advisory lock is transaction-scoped, not session-scoped', async () => {
    // Defect 1: a session-scoped lock on a pooled connection, released only by
    // an explicit unlock in a finally. If that unlock failed, or the process
    // died between lock and unlock, every subsequent member creation blocked
    // forever on a connection nobody could identify.
    await request(app()).post('/api/members').send({ name: 'X' });
    const lock = find(/pg_advisory_xact_lock/i);
    expect(lock).toBeDefined();
    expect(mockLog.some((q) => /pg_advisory_lock\b/.test(q.sql))).toBe(false);
    expect(mockLog.some((q) => /pg_advisory_unlock/.test(q.sql))).toBe(false);
  });

  test('the lock is keyed per organization, not globally', async () => {
    // The deleted version used one global constant because there was no
    // organization_id to key on. Member codes are per-studio now, so a global
    // lock would serialise every studio against every other for no reason.
    await request(app()).post('/api/members').send({ name: 'X' });
    expect(find(/pg_advisory_xact_lock/i).params[0]).toBe(ORG_A);
  });

  test('generation and insert share one transaction on one client', async () => {
    // Defect 2: the code was generated on one pooled connection and the row
    // inserted on another, with the lock dropped in between, so two concurrent
    // creates could read the same last code and both use it.
    await request(app()).post('/api/members').send({ name: 'X' });
    const tx = mockLog.filter((q) => q.tx).map((q) => q.sql);
    const iBegin  = tx.findIndex((s) => /^BEGIN/i.test(s));
    const iLock   = tx.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    const iMax    = tx.findIndex((s) => /MAX\(CAST\(SUBSTRING\(member_code/i.test(s));
    const iInsert = tx.findIndex((s) => /INSERT INTO members/i.test(s));
    const iCommit = tx.findIndex((s) => /^COMMIT/i.test(s));
    expect(iBegin).toBe(0);
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iMax).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iMax);
    expect(iCommit).toBeGreaterThan(iInsert);
    // Nothing in the sequence ran on the pool instead of the borrowed client.
    expect(mockLog.filter((q) => !q.tx && /INSERT INTO members/i.test(q.sql))).toHaveLength(0);
  });

  test('the next code is MAX + 1, never COUNT + 1', async () => {
    // Defect 3: COUNT(*) + 1 is not a sequence — delete one member and the next
    // code collides with one that already exists.
    await request(app()).post('/api/members').send({ name: 'X' });
    const q = find(/MAX\(CAST\(SUBSTRING\(member_code/i);
    expect(q.sql).toMatch(/MAX\(CAST\(SUBSTRING\(member_code FROM 2\) AS INTEGER\)\)/);
    expect(q.sql).not.toMatch(/COUNT\(/i);
    // maxCode 41 → M00042.
    expect(find(/INSERT INTO members/i).params[1]).toBe('M00042');
  });

  test('the code query is scoped to one organization', async () => {
    await request(app()).post('/api/members').send({ name: 'X' });
    const q = find(/MAX\(CAST\(SUBSTRING\(member_code/i);
    expect(q.sql).toMatch(/WHERE organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });
});
