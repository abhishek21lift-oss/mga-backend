'use strict';

/**
 * The public registration endpoint is the only unauthenticated write on the
 * platform, so what it CANNOT do matters more than what it can.
 *
 * These are unit tests over the handler. They prove the contract the handler
 * offers the database: that it reaches studio_registrations only through
 * platform_submit_studio_registration, and that no caller-supplied field can
 * reach a column the function does not accept.
 *
 * The other half of the guarantee is enforced by Postgres and cannot be
 * asserted here — that app_tenant has no SELECT, UPDATE or DELETE on the
 * table, so a leak is impossible even if this handler is wrong. That belongs
 * with the live-database checks in scripts/rls-security-verify.js, because a
 * mock cannot refuse a query the way RLS does.
 */

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('$2b$12$mockmockmockmockmockmo') }));

const pool = require('../db/pool');
const { handlers } = require('../modules/platform/super-admin/registrations');

const VALID = {
  full_name: 'Ada Lovelace',
  business_name: 'Analytical Fitness',
  mobile: '9876543210',
  email: 'ada@example.test',
  password: 'a-long-enough-password',
};

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const created = {
  registration_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  registration_status: 'pending',
  created_at: new Date('2026-01-01T00:00:00Z'),
  was_duplicate: false,
};

beforeEach(() => {
  pool.query.mockReset();
});

describe('POST /api/registrations — what the handler sends to the database', () => {
  it('writes only through the SECURITY DEFINER function, never a bare INSERT', async () => {
    pool.query.mockResolvedValue({ rows: [created] });
    const res = mockRes();
    await handlers.create({ body: { ...VALID } }, res, (e) => { throw e; });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/platform_submit_studio_registration/);
    // The whole point of 162: no direct DML against the table from this path.
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
  });

  it('passes exactly five arguments, so there is no channel for a sixth', async () => {
    pool.query.mockResolvedValue({ rows: [created] });
    await handlers.create({ body: { ...VALID } }, mockRes(), (e) => { throw e; });

    const [, args] = pool.query.mock.calls[0];
    expect(args).toHaveLength(5);
    expect(args[4]).toMatch(/^\$2[aby]\$/);      // the bcrypt hash, not the plaintext
    expect(args).not.toContain(VALID.password);  // plaintext never reaches SQL
  });

  it('ignores organization_id, status, reviewed_by and reviewed_at when forged', async () => {
    pool.query.mockResolvedValue({ rows: [created] });
    const res = mockRes();
    await handlers.create({
      body: {
        ...VALID,
        organization_id: '11111111-1111-1111-1111-111111111111',
        status: 'approved',
        reviewed_by: 'attacker',
        reviewed_at: '2020-01-01T00:00:00Z',
        review_note: 'approved by me',
      },
    }, res, (e) => { throw e; });

    const [, args] = pool.query.mock.calls[0];
    expect(args).toEqual([
      VALID.full_name, VALID.business_name, expect.any(String), VALID.email, expect.any(String),
    ]);
    // Not merely absent from the arguments — absent from the reply, so the
    // applicant cannot confirm whether a forged value was taken.
    const body = res.json.mock.calls[0][0];
    expect(body.data.organization_id).toBeNull();
    expect(body.data.status).toBe('pending');
    expect(body.data.reviewed_by).toBeNull();
    expect(body.data.reviewed_at).toBeNull();
  });

  it('never returns password_hash', async () => {
    pool.query.mockResolvedValue({ rows: [created] });
    const res = mockRes();
    await handlers.create({ body: { ...VALID } }, res, (e) => { throw e; });

    const body = res.json.mock.calls[0][0];
    expect(body.data).not.toHaveProperty('password_hash');
    expect(JSON.stringify(body)).not.toMatch(/\$2[aby]\$/);
  });

  it('answers a duplicate exactly as it answers a new application, minus the id', async () => {
    pool.query.mockResolvedValue({
      rows: [{ registration_id: null, registration_status: 'pending', created_at: null, was_duplicate: true }],
    });
    const res = mockRes();
    await handlers.create({ body: { ...VALID } }, res, (e) => { throw e; });

    expect(res.status).toHaveBeenCalledWith(202);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({ data: { status: 'pending' } });
    // An id here would answer "is this studio already on the platform?" for
    // anyone who asked, which is the enumeration oracle 146's partial unique
    // index and this response shape both exist to prevent.
    expect(body.data.id).toBeUndefined();
  });

  it('rejects invalid input before touching the database at all', async () => {
    const res = mockRes();
    await handlers.create({ body: { ...VALID, email: 'not-an-email' } }, res, (e) => { throw e; });

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
