// What POST /api/qr/scan tells the scanner about the person it just read.
//
// The check-in screen draws the member's face on its result card. That only
// works if the reply carries a photo, and it used to carry one on exactly one
// of the three branches — a fresh check-in. A repeat scan and a refused scan
// both came back as `{ id, name, status }`, so the two outcomes where the desk
// most needs to see who is standing there were the two that showed initials.
//
// The three branches are also the contract the frontend's outcomeOf() reads:
// duplicate is flagged while `success` stays true, because the request
// succeeded and the check-in did not. If that ever collapses to a plain
// boolean, every second scan becomes a fresh arrival and the day's count
// inflates. These tests pin the distinction from this side.

const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'admin', organization_id: '11111111-1111-1111-1111-111111111111', trainer_id: null };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const qrRouter = require('../routes/qr-checkin');

const app = express();
app.use(express.json());
app.use('/api/qr', qrRouter);

function signedQr(userId, userType = 'client') {
  const msg = `${userId}|${userType}|0`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(msg).digest('hex');
  return Buffer.from(`${msg}|${sig}`).toString('base64url');
}

const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** A member row as resolveUser returns it. */
const memberRow = (over = {}) => ({
  id: MEMBER,
  name: 'Hari Narayan Singh',
  status: 'active',
  photo_url: '/uploads/hari.jpg',
  member_code: 'MPS-014',
  client_id: 'MPS-014',
  package_type: 'Fat Loss',
  pt_end_date: '2099-01-01',
  ...over,
});

const scan = () => request(app).post('/api/qr/scan').send({ payload: signedQr(MEMBER) });

beforeEach(() => pool.query.mockReset());

describe('the scan reply carries the member on every branch', () => {
  it('on a fresh check-in', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow()] })  // resolveUser
      .mockResolvedValueOnce({ rows: [] })             // duplicate check
      .mockResolvedValueOnce({ rows: [{ id: 'att-1', check_in_time: '2026-08-06T04:30:00Z' }] });

    const res = await scan();

    expect(res.body.success).toBe(true);
    expect(res.body.duplicate).toBeUndefined();
    expect(res.body.user).toMatchObject({
      name: 'Hari Narayan Singh',
      photo_url: '/uploads/hari.jpg',
      member_code: 'MPS-014',
      status: 'active',
    });
  });

  it('on a repeat scan — the branch that used to send no photo', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1', check_in_time: '2026-08-06T04:30:00Z' }] });

    const res = await scan();

    expect(res.body.duplicate).toBe(true);
    expect(res.body.user.photo_url).toBe('/uploads/hari.jpg');
    expect(res.body.user.member_code).toBe('MPS-014');
  });

  it('on a refused scan — the branch where the desk most needs a face', async () => {
    // Package ended last year, so membershipStatus() says expired.
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow({ pt_end_date: '2020-01-01' })] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await scan();

    expect(res.body.success).toBe(false);
    expect(res.body.user.photo_url).toBe('/uploads/hari.jpg');
    expect(res.body.user.status).toBe('expired');
  });
});

describe('the three outcomes stay distinguishable', () => {
  it('flags a repeat scan as duplicate while success stays true', async () => {
    // Both halves matter. `success: true` is honest — the request worked.
    // `duplicate: true` is what says no check-in was recorded, and it is the
    // only thing separating this from a fresh arrival on the client.
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1', check_in_time: '2026-08-06T04:30:00Z' }] });

    const res = await scan();

    expect(res.body.success).toBe(true);
    expect(res.body.duplicate).toBe(true);
  });

  it('does not write a second attendance row for a repeat scan', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1', check_in_time: '2026-08-06T04:30:00Z' }] });

    await scan();

    const writes = pool.query.mock.calls.filter(([sql]) => /INSERT INTO attendance_logs/i.test(sql));
    expect(writes).toHaveLength(0);
  });

  it('returns the attendance id on a repeat scan so the feed can dedupe it', async () => {
    // The scanner keys its local feed on this id and drops the duplicate when
    // the same row arrives from the dashboard poll. Without it, a repeat scan
    // shows up as a second person.
    pool.query
      .mockResolvedValueOnce({ rows: [memberRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-77', check_in_time: '2026-08-06T04:30:00Z' }] });

    const res = await scan();
    expect(res.body.attendance_id).toBe('att-77');
  });
});

describe('none of this loosens tenant scoping', () => {
  it('still returns nothing at all for someone outside the caller org', async () => {
    // publicUser() is built from the row resolveUser returned, and resolveUser
    // is org-filtered — so a foreign member never reaches it. Asserted here
    // as well as in the isolation suite because this change widened what the
    // reply contains, which is exactly the kind of edit that leaks.
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await scan();

    expect(res.status).toBe(404);
    expect(res.body.user).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/uploads|MPS-/);
  });
});
