// Security Centre routes.
//
// Read-only surfaces, so what matters is that they measure the right thing and
// that the filters they offer actually reach the SQL — a security dashboard
// that quietly ignores a filter shows an operator a reassuring number about
// the wrong set.
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

const calls = () => pool.query.mock.calls.map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }));
const call = (re) => calls().find((c) => re.test(c.sql));

const STATS = {
  success_24h: 40, failed_24h: 12, failing_ips_24h: 3,
  targeted_accounts_24h: 5, mfa_failed_24h: 2,
};

beforeEach(() => pool.query.mockReset());

describe('overview', () => {
  it('reports the platform operators without a second factor', async () => {
    // A super_admin without MFA can reach every studio's data, so this is the
    // single most important number on the page.
    pool.query
      .mockResolvedValueOnce({ rows: [STATS] })
      .mockResolvedValueOnce({ rows: [
        { id: 'op-2', name: 'Second Op', mfa_enabled: false },
        { id: 'op-1', name: 'Owner', mfa_enabled: true },
      ] })
      .mockResolvedValueOnce({ rows: [{ active: 7 }] })
      .mockResolvedValueOnce({ rows: [{ impersonations_7d: 2 }] });

    const res = await request(app()).get('/api/super-admin/security/overview');

    expect(res.status).toBe(200);
    expect(res.body.data.operators.total).toBe(2);
    expect(res.body.data.operators.without_mfa).toBe(1);
    expect(res.body.data.active_sessions).toBe(7);
    expect(res.body.data.impersonations_7d).toBe(2);
  });

  it('treats an operator with no profile row as unprotected', async () => {
    // The LEFT JOIN must not silently drop an account that never enrolled —
    // that is exactly the account most worth flagging.
    pool.query
      .mockResolvedValueOnce({ rows: [STATS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active: 0 }] })
      .mockResolvedValueOnce({ rows: [{ impersonations_7d: 0 }] });
    await request(app()).get('/api/super-admin/security/overview');
    expect(call(/role = 'super_admin'/).sql).toMatch(/COALESCE\(p\.mfa_enabled, FALSE\)/);
  });

  it('surfaces MFA failures separately from ordinary bad passwords', async () => {
    // A wrong second factor against a CORRECT password means the password is
    // already compromised — averaging it into "failed logins" hides that.
    pool.query
      .mockResolvedValueOnce({ rows: [STATS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active: 0 }] })
      .mockResolvedValueOnce({ rows: [{ impersonations_7d: 0 }] });
    const res = await request(app()).get('/api/super-admin/security/overview');
    expect(res.body.data.logins_24h.mfa_failed_24h).toBe(2);
  });

  it('is measured at request time, never cached', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [STATS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active: 0 }] })
      .mockResolvedValueOnce({ rows: [{ impersonations_7d: 0 }] });
    const res = await request(app()).get('/api/super-admin/security/overview');
    expect(new Date(res.body.data.checked_at).getTime()).toBeCloseTo(Date.now(), -4);
  });
});

describe('login events feed', () => {
  const setup = () => pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ n: 0 }] });

  it('applies the same filter to the rows and to the count', async () => {
    setup();
    await request(app()).get('/api/super-admin/security/login-events?outcome=bad_password&q=iron');
    const [list, count] = calls();
    expect(list.sql).toMatch(/e\.outcome = \$1/);
    expect(count.sql).toMatch(/e\.outcome = \$1/);
    expect(count.params).toEqual(list.params.slice(0, count.params.length));
  });

  it('offers a plain "failures only" switch', async () => {
    // Spelling out five outcome values in a query string is not something an
    // operator should have to do to see what matters.
    setup();
    await request(app()).get('/api/super-admin/security/login-events?failed=true');
    expect(calls()[0].sql).toMatch(/e\.outcome <> 'success'/);
  });

  it('filters by IP, user, org and method', async () => {
    for (const [q, frag] of [
      ['ip=203.0.113.9', /e\.ip_address = \$1/],
      ['user_id=u1', /e\.user_id = \$1/],
      ['org_id=11111111-1111-1111-1111-111111111111', /e\.organization_id = \$1::uuid/],
      ['method=passkey', /e\.method = \$1/],
    ]) {
      pool.query.mockReset();
      setup();
      await request(app()).get(`/api/super-admin/security/login-events?${q}`);
      expect(calls()[0].sql).toMatch(frag);
    }
  });

  it('makes the end date inclusive of its whole day', async () => {
    setup();
    await request(app()).get('/api/super-admin/security/login-events?to=2026-03-31');
    expect(calls()[0].sql).toMatch(/INTERVAL '1 day'/);
  });

  it('caps the page size however large a limit is asked for', async () => {
    setup();
    await request(app()).get('/api/super-admin/security/login-events?limit=99999');
    expect(calls()[0].params).toContain(200);
  });
});

describe('threats', () => {
  const setup = () => pool.query
    .mockResolvedValueOnce({ rows: [{ email_attempted: 'p@x.in', failures: 9, succeeded_after: true }] })
    .mockResolvedValueOnce({ rows: [{ ip_address: '198.51.100.4', failures: 6, accounts_targeted: 6 }] });

  it('groups by account AND by address, because they are different attacks', async () => {
    // Many failures at one account is someone guessing a specific password;
    // many failures from one address across many accounts is credential
    // stuffing. One combined list hides whichever is currently smaller.
    setup();
    const res = await request(app()).get('/api/super-admin/security/threats');
    expect(res.status).toBe(200);
    expect(res.body.data.by_account).toHaveLength(1);
    expect(res.body.data.by_ip).toHaveLength(1);
  });

  it('flags a run that ended in a success', async () => {
    // The difference between a repelled attack and a breach to investigate now.
    setup();
    const res = await request(app()).get('/api/super-admin/security/threats');
    expect(res.body.data.by_account[0].succeeded_after).toBe(true);
  });

  it('ranks addresses by how many accounts they swept, not raw volume', async () => {
    setup();
    await request(app()).get('/api/super-admin/security/threats');
    expect(calls()[1].sql).toMatch(/ORDER BY count\(DISTINCT e\.email_attempted\) DESC/);
  });

  it('clamps the window and the threshold to sane values', async () => {
    for (const [q, wantWindow, wantMin] of [
      ['hours=0&min=0', '1', 2],
      ['hours=99999&min=1', '720', 2],
      ['hours=48&min=10', '48', 10],
      ['', '24', 5],
    ]) {
      pool.query.mockReset();
      setup();
      await request(app()).get(`/api/super-admin/security/threats?${q}`);
      expect(calls()[0].params).toEqual([wantWindow, wantMin]);
    }
  });

  it('only ever looks at failures', async () => {
    setup();
    await request(app()).get('/api/super-admin/security/threats');
    for (const c of calls()) expect(c.sql).toMatch(/e\.outcome <> 'success'/);
  });
});

describe('sessions', () => {
  it('counts only live tokens', async () => {
    // A revoked or expired token is not a session, and counting it would tell
    // an operator someone is signed in who is not.
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', name: 'Priya', sessions: 2 }] });
    const res = await request(app()).get('/api/super-admin/security/sessions');
    expect(res.status).toBe(200);
    expect(call(/FROM refresh_tokens/).sql).toMatch(/r\.revoked_at IS NULL AND r\.expires_at > now\(\)/);
  });

  it('scopes to one studio when asked', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/super-admin/security/sessions?org_id=11111111-1111-1111-1111-111111111111');
    expect(call(/FROM refresh_tokens/).sql).toMatch(/u\.organization_id = \$1::uuid/);
  });
});
