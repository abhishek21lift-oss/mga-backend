// /api/memberships and /api/membership-plans — Phase 3.
//
// Two things are pinned here, and they fail differently.
//
// TENANCY, the five-step matrix per verb: Tenant A creates → A reads → B cannot
// read → B cannot update → B cannot delete. Asserted against the SQL reaching
// the database, because a 404 can come from an empty fixture as easily as from a
// working predicate.
//
// ARITHMETIC, which is the part that will not announce itself. A membership is
// dates and money, and every one of these is wrong in a way that looks fine:
//
//   · a 30-day plan starting on the 1st ending on the 31st — twelve free days a
//     year on a monthly membership;
//   · a renewal back-dated onto a lapsed term, selling days already gone;
//   · a joining fee charged again on renewal;
//   · a freeze that closes without extending the term, so the member silently
//     loses the days they paid for;
//   · a total taken from the request instead of computed, so a caller sets their
//     own price.
//
// None of those throws. All of them are money.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mock;

const mockTx = {
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [], tx: true });
    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT 1 FROM members WHERE id = \$1 AND organization_id = \$2/i.test(text)) {
      return { rows: mock.memberOk ? [{}] : [], rowCount: mock.memberOk ? 1 : 0 };
    }
    if (/FROM membership_plans/i.test(text)) {
      return { rows: mock.plan ? [mock.plan] : [], rowCount: mock.plan ? 1 : 0 };
    }
    if (/SELECT \* FROM memberships/i.test(text)) {
      return { rows: mock.membership ? [mock.membership] : [], rowCount: mock.membership ? 1 : 0 };
    }
    if (/FROM membership_freezes/i.test(text) && /FOR UPDATE/i.test(text)) {
      return { rows: mock.openFreeze ? [mock.openFreeze] : [], rowCount: mock.openFreeze ? 1 : 0 };
    }
    if (/GREATEST\(\(\$1::date - \$2::date\) \+ 1, 0\)/i.test(text)) {
      // The real database does this subtraction; the fixture reproduces it so
      // the assertion is about the SQL being right, not about JS date maths.
      const [to, from] = params;
      const days = Math.max(Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1, 0);
      return { rows: [{ days }], rowCount: 1 };
    }
    if (/INSERT INTO memberships|UPDATE memberships/i.test(text)) {
      if (mock.writeError) throw mock.writeError;
      return { rows: [{ id: 'ms-new', ends_on: mock.newEndsOn ?? '2026-03-02' }], rowCount: 1 };
    }
    if (/INSERT INTO membership_freezes/i.test(text)) {
      if (mock.writeError) throw mock.writeError;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(async () => mockTx),
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [], tx: false });
    if (/FROM membership_events/i.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM membership_freezes/i.test(text)) return { rows: [], rowCount: 0 };
    // Matches membership_plans anywhere, not just after FROM: the UPDATE and
    // the soft-delete are `UPDATE membership_plans SET … RETURNING`, so a
    // FROM-only branch let them fall through to the memberships fixture and
    // return a row when the tenant predicate should have matched none — which
    // turned a 404 assertion into a passing 200.
    if (/membership_plans/i.test(text)) return { rows: mock.planList, rowCount: mock.planList.length };
    return { rows: mock.list, rowCount: mock.list.length };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' })),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/membership-plans', require('../routes/membership-plans'));
  a.use('/api/memberships', require('../routes/memberships'));
  return a;
}

const PLAN = { id: 'p-1', name: 'Basic', duration_days: 30, price: 1500, joining_fee: 500, tax_pct: 18 };

beforeEach(() => {
  mockLog.length = 0;
  mockTx.query.mockClear();
  mockTx.release.mockClear();
  mock = {
    memberOk: true,
    plan: PLAN,
    planList: [PLAN],
    list: [{ id: 'ms-1', member_id: 'm-1', status: 'active' }],
    membership: {
      id: 'ms-1', organization_id: ORG_A, member_id: 'm-1', plan_id: 'p-1',
      plan_name: 'Basic', starts_on: new Date('2026-01-01T00:00:00Z'),
      ends_on: new Date('2026-01-30T00:00:00Z'), status: 'active', price: 1500,
    },
    openFreeze: null,
    writeError: null,
    newEndsOn: '2026-03-02',
  };
  mockUser = { id: 'u-a', role: 'admin', organization_id: ORG_A };
});

const find = (re) => mockLog.find((q) => re.test(q.sql));
const findAll = (re) => mockLog.filter((q) => re.test(q.sql));
const asTenantB = () => { mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B }; };

// ── Plans ───────────────────────────────────────────────────────────────────

describe('membership plans are per studio', () => {
  test('GET / scopes the catalogue', async () => {
    await request(app()).get('/api/membership-plans');
    const q = find(/FROM membership_plans/i);
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('POST / stamps the caller organization', async () => {
    mock.planList = [{ id: 'p-new' }];
    await request(app()).post('/api/membership-plans')
      .send({ name: 'Gold', duration_days: 365, price: 20000 });
    const q = find(/INSERT INTO membership_plans/i);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('two studios may both have a plan called Basic', async () => {
    // uq_membership_plans_org_name is (organization_id, lower(name)) — the
    // tenant-scoped form. V-15 is the same defect on pt_plans, whose bare
    // UNIQUE(name) means the second studio to want "Basic PT" cannot have it.
    asTenantB();
    mock.planList = [{ id: 'p-b' }];
    const res = await request(app()).post('/api/membership-plans')
      .send({ name: 'Basic', duration_days: 30, price: 1800 });
    expect(res.status).toBe(201);
    expect(find(/INSERT INTO membership_plans/i).params[0]).toBe(ORG_B);
  });

  test('a duplicate name inside one studio is a 409', async () => {
    const pool = require('../db/pool');
    pool.query.mockImplementationOnce(async () => { const e = new Error('dup'); e.code = '23505'; throw e; });
    const res = await request(app()).post('/api/membership-plans')
      .send({ name: 'Basic', duration_days: 30, price: 1500 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_EXISTS');
  });

  test("tenant B cannot update or delete tenant A's plan", async () => {
    asTenantB();
    mock.planList = [];
    const upd = await request(app()).put('/api/membership-plans/p-1').send({ price: 1 });
    expect(upd.status).toBe(404);
    expect(find(/UPDATE membership_plans SET/i).params).toContain(ORG_B);

    mockLog.length = 0;
    const del = await request(app()).delete('/api/membership-plans/p-1');
    expect(del.status).toBe(404);
    expect(find(/SET deleted_at = NOW\(\)/i).params).toContain(ORG_B);
  });

  test('deleting a plan is soft, so memberships keep their history', async () => {
    mock.planList = [{ id: 'p-1' }];
    await request(app()).delete('/api/membership-plans/p-1');
    expect(find(/UPDATE membership_plans SET deleted_at/i)).toBeDefined();
    expect(mockLog.some((q) => /DELETE FROM membership_plans/i.test(q.sql))).toBe(false);
  });
});

// ── Selling ─────────────────────────────────────────────────────────────────

describe('POST /api/memberships — selling a membership', () => {
  const body = { member_id: 'm-1', plan_id: 'p-1' };

  test('rejects a member belonging to another studio', async () => {
    mock.memberOk = false;
    const res = await request(app()).post('/api/memberships').send(body);
    expect(res.status).toBe(404);
    expect(mockLog.some((q) => /INSERT INTO memberships/i.test(q.sql))).toBe(false);
    expect(findAll(/^ROLLBACK/i)).toHaveLength(1);
  });

  test('rejects a plan belonging to another studio', async () => {
    mock.plan = null;
    const res = await request(app()).post('/api/memberships').send(body);
    expect(res.status).toBe(404);
    expect(find(/FROM membership_plans/i).params).toEqual(['p-1', ORG_A]);
  });

  test('a 30-day plan starting on the 1st ends on the 30th, not the 31st', async () => {
    // duration_days - 1. Off by one here is twelve free days a year.
    await request(app()).post('/api/memberships')
      .send({ ...body, starts_on: '2026-01-01' });
    const q = find(/INSERT INTO memberships/i);
    expect(q.params[4]).toBe('2026-01-01'); // starts_on
    expect(q.params[5]).toBe('2026-01-30'); // ends_on
  });

  test('computes the total rather than trusting the request', async () => {
    // (1500 - 0 + 500) * 1.18 = 2360. A caller posting total: 1 must not win.
    await request(app()).post('/api/memberships')
      .send({ ...body, total: 1, tax_amount: 0 });
    const q = find(/INSERT INTO memberships/i);
    expect(Number(q.params[10])).toBeCloseTo(360, 2);  // tax_amount
    expect(Number(q.params[11])).toBeCloseTo(2360, 2); // total
  });

  test('a discount reduces the taxable subtotal, and cannot exceed the price', async () => {
    await request(app()).post('/api/memberships').send({ ...body, discount: 99999 });
    const q = find(/INSERT INTO memberships/i);
    expect(Number(q.params[8])).toBe(1500);            // discount clamped to price
    expect(Number(q.params[11])).toBeCloseTo(590, 2);  // (0 + 500) * 1.18
  });

  test('the joining fee can be waived', async () => {
    await request(app()).post('/api/memberships')
      .send({ ...body, include_joining_fee: false });
    const q = find(/INSERT INTO memberships/i);
    expect(Number(q.params[9])).toBe(0);
    expect(Number(q.params[11])).toBeCloseTo(1770, 2); // 1500 * 1.18
  });

  test('records a created event in the same transaction', async () => {
    await request(app()).post('/api/memberships').send(body);
    const tx = mockLog.filter((q) => q.tx).map((q) => q.sql);
    const iInsert = tx.findIndex((s) => /INSERT INTO memberships/i.test(s));
    const iEvent = tx.findIndex((s) => /INSERT INTO membership_events/i.test(s));
    const iCommit = tx.findIndex((s) => /^COMMIT/i.test(s));
    expect(iEvent).toBeGreaterThan(iInsert);
    expect(iCommit).toBeGreaterThan(iEvent);
    expect(find(/INSERT INTO membership_events/i).params[0]).toBe(ORG_A);
  });

  test('a trainer cannot sell a membership, reception can', async () => {
    mockUser = { id: 'u-t', role: 'trainer', organization_id: ORG_A };
    expect((await request(app()).post('/api/memberships').send(body)).status).toBe(403);

    mockUser = { id: 'u-r', role: 'reception', organization_id: ORG_A };
    expect((await request(app()).post('/api/memberships').send(body)).status).toBe(201);
  });
});

// ── Renewal ─────────────────────────────────────────────────────────────────

describe('POST /:id/renew', () => {
  test('continues from the day after the current term when it has not lapsed', async () => {
    mock.membership.ends_on = new Date('2099-06-30T00:00:00Z');
    await request(app()).post('/api/memberships/ms-1/renew').send({});
    const q = find(/INSERT INTO memberships/i);
    expect(q.params[4]).toBe('2099-07-01');
    expect(q.params[5]).toBe('2099-07-30');
  });

  test('starts today when the current term already lapsed', async () => {
    // Back-dating onto an expired term sells days that have already passed.
    mock.membership.ends_on = new Date('2020-01-31T00:00:00Z');
    await request(app()).post('/api/memberships/ms-1/renew').send({});
    const q = find(/INSERT INTO memberships/i);
    expect(q.params[4]).toBe(new Date().toISOString().slice(0, 10));
  });

  test('never charges the joining fee again', async () => {
    await request(app()).post('/api/memberships/ms-1/renew').send({});
    const q = find(/INSERT INTO memberships/i);
    // The INSERT hard-codes 0 for joining_fee on this path.
    expect(q.sql).toMatch(/VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,'active',\$7,\$8,0,/);
    expect(Number(q.params[9])).toBeCloseTo(1770, 2); // total = 1500 * 1.18
  });

  test('creates a new row rather than extending the old one', async () => {
    await request(app()).post('/api/memberships/ms-1/renew').send({});
    expect(find(/INSERT INTO memberships/i)).toBeDefined();
    expect(mockLog.some((q) => /UPDATE memberships SET ends_on/i.test(q.sql))).toBe(false);
  });

  test("tenant B cannot renew tenant A's membership", async () => {
    asTenantB();
    mock.membership = null;
    const res = await request(app()).post('/api/memberships/ms-1/renew').send({});
    expect(res.status).toBe(404);
    expect(find(/SELECT \* FROM memberships/i).params).toEqual(['ms-1', ORG_B]);
  });
});

// ── Freeze and resume ───────────────────────────────────────────────────────

describe('freeze and resume', () => {
  test('freezing sets status frozen and records the freeze', async () => {
    const res = await request(app()).post('/api/memberships/ms-1/freeze')
      .send({ from_date: '2026-01-10', reason: 'travel' });
    expect(res.status).toBe(200);
    expect(find(/INSERT INTO membership_freezes/i).params[0]).toBe(ORG_A);
    expect(find(/UPDATE memberships SET status = 'frozen'/i)).toBeDefined();
  });

  test('only an active membership can be frozen', async () => {
    mock.membership.status = 'expired';
    const res = await request(app()).post('/api/memberships/ms-1/freeze').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ACTIVE');
  });

  test('a second open freeze is a 409, not a 500', async () => {
    const e = new Error('dup'); e.code = '23505'; e.constraint = 'uq_membership_freezes_open';
    mock.writeError = e;
    const res = await request(app()).post('/api/memberships/ms-1/freeze').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_FROZEN');
    expect(findAll(/^ROLLBACK/i)).toHaveLength(1);
  });

  test('resuming extends ends_on by the days frozen, inclusive of both ends', async () => {
    // Frozen 10 Jan, resumed 14 Jan = 5 days lost, so 5 days added back.
    mock.membership.status = 'frozen';
    mock.openFreeze = { id: 'fz-1', from_date: '2026-01-10' };
    const res = await request(app()).post('/api/memberships/ms-1/resume')
      .send({ to_date: '2026-01-14' });
    expect(res.status).toBe(200);
    expect(res.body.frozen_days).toBe(5);
    const upd = find(/UPDATE memberships SET ends_on = ends_on \+ \$1::int/i);
    expect(upd.params[0]).toBe(5);
    expect(upd.params[2]).toBe(ORG_A);
  });

  test('frozen and resumed on the same day is one day, not zero', async () => {
    mock.membership.status = 'frozen';
    mock.openFreeze = { id: 'fz-1', from_date: '2026-01-10' };
    const res = await request(app()).post('/api/memberships/ms-1/resume')
      .send({ to_date: '2026-01-10' });
    expect(res.body.frozen_days).toBe(1);
  });

  test('the extension is computed in SQL, clamped against a back-dated resume', async () => {
    // A negative extension would silently shorten a paid term.
    mock.membership.status = 'frozen';
    mock.openFreeze = { id: 'fz-1', from_date: '2026-01-10' };
    await request(app()).post('/api/memberships/ms-1/resume').send({ to_date: '2026-01-01' });
    const calc = find(/GREATEST/i);
    expect(calc.sql).toMatch(/GREATEST\(\(\$1::date - \$2::date\) \+ 1, 0\)::int/);
  });

  test('resuming a membership with no open freeze is a 409', async () => {
    mock.openFreeze = null;
    const res = await request(app()).post('/api/memberships/ms-1/resume').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_FROZEN');
  });

  test('the open-freeze lookup is scoped and locks the row', async () => {
    mock.openFreeze = { id: 'fz-1', from_date: '2026-01-10' };
    await request(app()).post('/api/memberships/ms-1/resume').send({});
    const q = find(/FROM membership_freezes.*FOR UPDATE/is);
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params).toEqual(['ms-1', ORG_A]);
  });
});

// ── Change of plan ──────────────────────────────────────────────────────────

describe('POST /:id/change-plan', () => {
  test('a dearer plan is an upgrade, a cheaper one a downgrade', async () => {
    mock.plan = { ...PLAN, id: 'p-2', name: 'Gold', price: 5000, duration_days: 90 };
    let res = await request(app()).post('/api/memberships/ms-1/change-plan').send({ plan_id: 'p-2' });
    expect(res.body.change).toBe('upgraded');

    mockLog.length = 0;
    mock.plan = { ...PLAN, id: 'p-3', name: 'Lite', price: 500, duration_days: 30 };
    res = await request(app()).post('/api/memberships/ms-1/change-plan').send({ plan_id: 'p-3' });
    expect(res.body.change).toBe('downgraded');
  });

  test('re-dates the end from the ORIGINAL start, not from today', async () => {
    // Otherwise an upgrade mid-term stacks a fresh full term on top of the one
    // already paid for.
    mock.plan = { ...PLAN, id: 'p-2', name: 'Gold', price: 5000, duration_days: 90 };
    await request(app()).post('/api/memberships/ms-1/change-plan').send({ plan_id: 'p-2' });
    const q = find(/UPDATE memberships SET plan_id/i);
    expect(q.params[2]).toBe('2026-03-31'); // 2026-01-01 + 89
  });

  test('refuses a change to the plan already held', async () => {
    const res = await request(app()).post('/api/memberships/ms-1/change-plan').send({ plan_id: 'p-1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SAME_PLAN');
  });

  test('refuses on a cancelled membership', async () => {
    mock.membership.status = 'cancelled';
    mock.plan = { ...PLAN, id: 'p-2' };
    const res = await request(app()).post('/api/memberships/ms-1/change-plan').send({ plan_id: 'p-2' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CHANGEABLE');
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('POST /:id/cancel', () => {
  test('cancels within the caller organization and records it', async () => {
    const res = await request(app()).post('/api/memberships/ms-1/cancel').send({ reason: 'moved away' });
    expect(res.status).toBe(200);
    const q = find(/SET status = 'cancelled'/i);
    expect(q.sql).toMatch(/organization_id = \$3/);
    expect(q.params[2]).toBe(ORG_A);
  });

  test('closes any open freeze, so a future freeze is not blocked forever', async () => {
    // uq_membership_freezes_open is partial on resumed_at IS NULL. A cancelled
    // membership with an open freeze can never be resumed, so the row would
    // block the constraint indefinitely.
    await request(app()).post('/api/memberships/ms-1/cancel').send({});
    const q = find(/UPDATE membership_freezes SET resumed_at = NOW\(\)/i);
    expect(q).toBeDefined();
    expect(q.params).toEqual(['ms-1', ORG_A]);
  });

  test('cancelling twice is a 409', async () => {
    mock.membership.status = 'cancelled';
    const res = await request(app()).post('/api/memberships/ms-1/cancel').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  test('reception cannot cancel — admin and manager only', async () => {
    mockUser = { id: 'u-r', role: 'reception', organization_id: ORG_A };
    expect((await request(app()).post('/api/memberships/ms-1/cancel').send({})).status).toBe(403);
  });
});

// ── Listing ─────────────────────────────────────────────────────────────────

describe('GET /api/memberships', () => {
  test('scopes the list and joins the member', async () => {
    await request(app()).get('/api/memberships');
    const q = find(/FROM memberships ms/i);
    expect(q.sql).toMatch(/ms\.organization_id = \$1/);
    expect(q.sql).toMatch(/JOIN members m ON m\.id = ms\.member_id/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('the org predicate does not depend on any optional filter', async () => {
    await request(app()).get('/api/memberships');
    expect(find(/FROM memberships ms/i).sql).toMatch(/organization_id/);
    mockLog.length = 0;
    await request(app()).get('/api/memberships?status=active&member_id=m-1&expiring_in=7');
    expect(find(/FROM memberships ms/i).sql).toMatch(/organization_id/);
  });

  test('expiring_in is bounded and parameterised, not interpolated', async () => {
    await request(app()).get('/api/memberships?expiring_in=99999');
    const q = find(/FROM memberships ms/i);
    expect(q.sql).toMatch(/CURRENT_DATE \+ \$\d+::int/);
    expect(q.params).toContain(365);
  });

  test('every state-changing route opens a transaction', async () => {
    // borrowedClientScope.convention.test.js enforces this at the source level;
    // this checks the actual call order, which the static test cannot.
    for (const path of ['/api/memberships/ms-1/renew', '/api/memberships/ms-1/cancel']) {
      mockLog.length = 0;
      mock.membership.status = 'active';
      await request(app()).post(path).send({});
      const tx = mockLog.filter((q) => q.tx).map((q) => q.sql);
      expect(tx[0]).toMatch(/^BEGIN/i);
      expect(tx[tx.length - 1]).toMatch(/^COMMIT|^ROLLBACK/i);
      expect(mockTx.release).toHaveBeenCalled();
    }
  });
});
