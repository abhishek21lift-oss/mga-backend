jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  invalidateUserCache: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/platform/super-admin.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const call = (re) => pool.query.mock.calls.find(([sql]) => re.test(sql));
const TENANT = { id: 'u9', name: 'Studio Admin', email: 'a@studio.com', role: 'admin', organization_id: 'org-1' };

beforeEach(() => pool.query.mockReset());

describe('force logout', () => {
  it('bumps token_version, which is what revokes live JWTs', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ id: 'u9', token_version: 4 }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).post('/api/super-admin/users/u9/force-logout');

    expect(res.status).toBe(200);
    expect(call(/UPDATE users SET token_version/)).toBeDefined();
  });

  it('does not touch the password — signing out is not locking out', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ id: 'u9', token_version: 1 }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).post('/api/super-admin/users/u9/force-logout');

    expect(pool.query.mock.calls.some(([sql]) => /password/i.test(sql))).toBe(false);
  });

  it('refuses to act on a platform account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...TENANT, role: 'super_admin' }] });

    const res = await request(app()).post('/api/super-admin/users/op-2/force-logout');

    expect(res.status).toBe(403);
    expect(call(/UPDATE users SET token_version/)).toBeUndefined();
  });

  it('404s on an unknown user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).post('/api/super-admin/users/nope/force-logout');
    expect(res.status).toBe(404);
  });
});

describe('reset MFA', () => {
  it('clears the factor and revokes sessions with it', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ mfa_enabled: true }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).post('/api/super-admin/users/u9/reset-mfa');

    expect(res.status).toBe(200);
    expect(res.body.data.was_enabled).toBe(true);
    // A session that outlived the factor authorising it would defeat the point.
    expect(call(/UPDATE user_profiles SET mfa_enabled = FALSE/)).toBeDefined();
    expect(call(/UPDATE users SET token_version/)).toBeDefined();
  });

  it('records the previous state, since removing a security factor is weighty', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ mfa_enabled: true }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).post('/api/super-admin/users/u9/reset-mfa');

    const insert = call(/INSERT INTO activity_log/);
    expect(insert[1]).toEqual(expect.arrayContaining(['user_mfa_reset']));
    expect(JSON.stringify(insert[1])).toMatch(/was_enabled/);
  });

  it('refuses to act on a platform account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...TENANT, role: 'super_admin' }] });
    const res = await request(app()).post('/api/super-admin/users/op-2/reset-mfa');
    expect(res.status).toBe(403);
  });
});

describe('bonus days', () => {
  const future = new Date(Date.now() + 10 * 86400000).toISOString();
  const past = new Date(Date.now() - 10 * 86400000).toISOString();

  it('extends current_period_end for a paying studio', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', subscription_status: 'active', current_period_end: future, trial_ends_at: null }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).post('/api/super-admin/organizations/org-1/subscription/bonus-days').send({ days: 14 });

    expect(res.status).toBe(200);
    expect(res.body.data.field).toBe('current_period_end');
    expect(new Date(res.body.data.current_period_end).getTime())
      .toBeCloseTo(new Date(future).getTime() + 14 * 86400000, -4);
  });

  it('extends trial_ends_at instead when the studio is still trialling', async () => {
    // Moving the wrong clock silently does nothing, which is the bug this guards.
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', subscription_status: 'trial', current_period_end: null, trial_ends_at: future }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).post('/api/super-admin/organizations/org-1/subscription/bonus-days').send({ days: 7 });

    expect(res.body.data.field).toBe('trial_ends_at');
    expect(call(/UPDATE organizations SET trial_ends_at/)).toBeDefined();
  });

  it('extends from today when the existing date already lapsed', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', subscription_status: 'active', current_period_end: past, trial_ends_at: null }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).post('/api/super-admin/organizations/org-1/subscription/bonus-days').send({ days: 30 });

    // "Give them 30 more days" on a lapsed account must land 30 days out, not
    // 20 days in the past.
    const granted = new Date(res.body.data.current_period_end).getTime();
    expect(granted).toBeGreaterThan(Date.now() + 29 * 86400000);
  });

  it('rejects zero, non-numeric and absurd values', async () => {
    for (const days of [0, 'abc', 400, -400, undefined]) {
      pool.query.mockReset();
      const res = await request(app()).post('/api/super-admin/organizations/org-1/subscription/bonus-days').send({ days });
      expect(res.status).toBe(400);
      expect(call(/UPDATE organizations/)).toBeUndefined();
    }
  });

  it('audits the delta, not just the resulting date', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'org-1', subscription_status: 'active', current_period_end: future, trial_ends_at: null }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).post('/api/super-admin/organizations/org-1/subscription/bonus-days')
      .send({ days: 14, reason: 'onboarding delay' });

    const insert = call(/INSERT INTO activity_log/);
    expect(insert[1]).toEqual(expect.arrayContaining(['subscription_bonus_days']));
    const payload = JSON.stringify(insert[1]);
    expect(payload).toMatch(/"days":14/);
    expect(payload).toMatch(/onboarding delay/);
  });
});

describe('internal notes', () => {
  it('saves notes with author and timestamp', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ internal_notes: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ internal_notes: 'new note', internal_notes_updated_at: new Date(), internal_notes_updated_by: 'Owner' }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).put('/api/super-admin/organizations/org-1/notes').send({ notes: 'new note' });

    expect(res.status).toBe(200);
    expect(res.body.data.internal_notes).toBe('new note');
    expect(call(/internal_notes_updated_by/)).toBeDefined();
  });

  it('audits only the length, never the note content', async () => {
    // The note is operator commentary about a customer and may name people;
    // copying it into activity_log would duplicate that needlessly.
    pool.query
      .mockResolvedValueOnce({ rows: [{ internal_notes: 'old' }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValue({ rows: [] });

    await request(app()).put('/api/super-admin/organizations/org-1/notes')
      .send({ notes: 'payment bounced twice, watch renewal' });

    const insert = call(/INSERT INTO activity_log/);
    const payload = JSON.stringify(insert[1]);
    expect(payload).toMatch(/new_length/);
    expect(payload).not.toMatch(/payment bounced/);
  });

  it('rejects an oversized note', async () => {
    const res = await request(app()).put('/api/super-admin/organizations/org-1/notes')
      .send({ notes: 'x'.repeat(20001) });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown organization', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).put('/api/super-admin/organizations/nope/notes').send({ notes: 'hi' });
    expect(res.status).toBe(404);
  });
});
