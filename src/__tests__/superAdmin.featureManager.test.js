// Feature Manager routes.
//
// The guards worth testing here are the ones that protect studios from an
// operator's mistake: core features that cannot be switched off, overrides
// that cannot be set without an explanation, and expiry dates that cannot
// silently be no-ops.
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

const ORG = { id: 'org-1', name: 'Iron House', plan_code: 'growth' };
const AI = { key: 'ai_suite', name: 'AI Suite', is_core: false, global_enabled: true, default_enabled: true, is_plan_gated: false };
const CORE = { key: 'clients', name: 'Clients', is_core: true, global_enabled: true, default_enabled: true, is_plan_gated: false };

beforeEach(() => pool.query.mockReset());

describe('catalogue', () => {
  it('returns the plan matrix shaped plan → feature → boolean', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...AI, override_count: 2, disabled_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ code: 'starter', name: 'Starter' }, { code: 'growth', name: 'Growth' }] })
      .mockResolvedValueOnce({ rows: [{ plan_code: 'growth', feature_key: 'ai_suite', enabled: true }] });

    const res = await request(app()).get('/api/super-admin/features');

    expect(res.status).toBe(200);
    expect(res.body.data.plan_matrix.growth.ai_suite).toBe(true);
    // A plan with no rows must still appear, or the grid loses a column.
    expect(res.body.data.plan_matrix.starter).toEqual({});
  });

  it('reports how many studios override each feature', async () => {
    // The number that tells an operator a global flip is about to collide with
    // deliberate per-studio decisions.
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...AI, override_count: 7, disabled_count: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/super-admin/features');
    expect(res.body.data.features[0].override_count).toBe(7);
  });
});

describe('platform switches', () => {
  it('flips the global kill switch', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [{ ...AI, global_enabled: false }] })
      .mockResolvedValueOnce({ rows: [{ studios: 42 }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).patch('/api/super-admin/features/ai_suite').send({ global_enabled: false });

    expect(res.status).toBe(200);
    expect(call(/UPDATE platform_features/).sql).toMatch(/global_enabled = \$2/);
  });

  it('records how many studios the change reached', async () => {
    // "Turned off the AI Suite" means something different against 3 studios
    // than against 300, and the count is not recoverable afterwards.
    pool.query
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [{ studios: 42 }] })
      .mockResolvedValue({ rows: [] });

    await request(app()).patch('/api/super-admin/features/ai_suite').send({ global_enabled: false });

    // The action is a SQL literal here, not a bound parameter — these routes
    // write activity_log directly rather than through the shared audit()
    // helper, because they carry an old_data payload it does not take.
    const insert = call(/INSERT INTO activity_log/);
    expect(insert.sql).toMatch(/'feature_updated'/);
    expect(JSON.stringify(insert.params)).toMatch(/"studios_affected":42/);
    // The previous state too, so the change is reversible from the log alone.
    expect(JSON.stringify(insert.params)).toMatch(/"global_enabled":true/);
  });

  it('refuses to change a core feature', async () => {
    pool.query.mockResolvedValueOnce({ rows: [CORE] });
    const res = await request(app()).patch('/api/super-admin/features/clients').send({ global_enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FEATURE');
    expect(call(/UPDATE platform_features/)).toBeUndefined();
  });

  it('404s on an unknown feature key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).patch('/api/super-admin/features/nope').send({ global_enabled: false });
    expect(res.status).toBe(404);
  });

  it('rejects an empty patch rather than writing nothing and reporting success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [AI] });
    const res = await request(app()).patch('/api/super-admin/features/ai_suite').send({ name: 'Renamed' });
    expect(res.status).toBe(400);
  });
});

describe('plan matrix', () => {
  it('upserts each plan row', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [{ code: 'starter' }, { code: 'growth' }] })
      .mockResolvedValueOnce({ rows: [{ plan_code: 'starter', enabled: true }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).put('/api/super-admin/features/ai_suite/plans')
      .send({ plans: { starter: false, growth: true } });

    expect(res.status).toBe(200);
    expect(calls().filter((c) => /INSERT INTO plan_features/.test(c.sql))).toHaveLength(2);
  });

  it('rejects an unknown plan code instead of creating a dangling row', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [{ code: 'growth' }] });
    const res = await request(app()).put('/api/super-admin/features/ai_suite/plans')
      .send({ plans: { enterprise: true } });
    expect(res.status).toBe(400);
    expect(call(/INSERT INTO plan_features/)).toBeUndefined();
  });

  it('rejects a non-object plans payload', async () => {
    pool.query.mockResolvedValueOnce({ rows: [AI] });
    const res = await request(app()).put('/api/super-admin/features/ai_suite/plans').send({ plans: ['starter'] });
    expect(res.status).toBe(400);
  });

  it('refuses to remove a core feature from a plan', async () => {
    pool.query.mockResolvedValueOnce({ rows: [CORE] });
    const res = await request(app()).put('/api/super-admin/features/clients/plans').send({ plans: { starter: false } });
    expect(res.status).toBe(400);
  });
});

describe('per-studio overrides', () => {
  const setup = () => pool.query
    .mockResolvedValueOnce({ rows: [ORG] })
    .mockResolvedValueOnce({ rows: [AI] })
    .mockResolvedValueOnce({ rows: [] })                       // previous override
    .mockResolvedValueOnce({ rows: [{ organization_id: 'org-1', feature_key: 'ai_suite', enabled: true }] })
    .mockResolvedValue({ rows: [] });

  it('sets an override with the operator recorded on it', async () => {
    setup();
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: true, reason: 'paid add-on, invoiced separately' });

    expect(res.status).toBe(200);
    expect(call(/INSERT INTO organization_features/).params).toContain('Owner');
  });

  it('requires a reason', async () => {
    // An unexplained flag on one studio is indistinguishable from a mistake
    // six months later, and whoever reads it will not be who set it.
    pool.query.mockResolvedValueOnce({ rows: [ORG] }).mockResolvedValueOnce({ rows: [AI] });
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/reason/i);
    expect(call(/INSERT INTO organization_features/)).toBeUndefined();
  });

  it('requires enabled to be an actual boolean', async () => {
    pool.query.mockResolvedValueOnce({ rows: [ORG] }).mockResolvedValueOnce({ rows: [AI] });
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: 'yes', reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an expiry that is already in the past', async () => {
    // Such an override resolves to nothing, so accepting it would hand the
    // operator a silent no-op they believe worked.
    pool.query.mockResolvedValueOnce({ rows: [ORG] }).mockResolvedValueOnce({ rows: [AI] });
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: true, reason: 'trial', expires_at: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(call(/INSERT INTO organization_features/)).toBeUndefined();
  });

  it('accepts a future expiry', async () => {
    setup();
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: true, reason: '30-day trial', expires_at: future });
    expect(res.status).toBe(200);
  });

  it('refuses to override a core feature', async () => {
    pool.query.mockResolvedValueOnce({ rows: [ORG] }).mockResolvedValueOnce({ rows: [CORE] });
    const res = await request(app()).put('/api/super-admin/organizations/org-1/features/clients')
      .send({ enabled: false, reason: 'testing' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FEATURE');
  });

  it('404s for an unknown studio', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).put('/api/super-admin/organizations/nope/features/ai_suite')
      .send({ enabled: true, reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('audits the previous override so a wrong flip can be undone', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ORG] })
      .mockResolvedValueOnce({ rows: [AI] })
      .mockResolvedValueOnce({ rows: [{ enabled: true, reason: 'was granted', expires_at: null }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValue({ rows: [] });

    await request(app()).put('/api/super-admin/organizations/org-1/features/ai_suite')
      .send({ enabled: false, reason: 'downgraded' });

    const insert = call(/INSERT INTO activity_log/);
    expect(JSON.stringify(insert.params)).toMatch(/was granted/);
    expect(JSON.stringify(insert.params)).toMatch(/downgraded/);
  });

  it('clears an override', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ enabled: false, reason: 'r', expires_at: null }] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/organizations/org-1/features/ai_suite');
    expect(res.status).toBe(200);
    expect(call(/INSERT INTO activity_log/).sql).toMatch(/'feature_override_cleared'/);
  });

  it('404s when clearing an override that was never set', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/organizations/org-1/features/ai_suite');
    expect(res.status).toBe(404);
  });
});

describe('resolved view', () => {
  it('returns each feature with the reason for its state', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ORG] })
      .mockResolvedValueOnce({ rows: [
        { key: 'clients', name: 'Clients', is_core: true, global_enabled: true, default_enabled: true, is_plan_gated: false, override_active: false, override_enabled: null, plan_enabled: null },
        { key: 'ai_suite', name: 'AI Suite', is_core: false, global_enabled: false, default_enabled: true, is_plan_gated: false, override_active: false, override_enabled: null, plan_enabled: null },
      ] });

    const res = await request(app()).get('/api/super-admin/organizations/org-1/features');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ key: 'clients', enabled: true, source: 'core' });
    expect(res.body.data[1]).toMatchObject({ key: 'ai_suite', enabled: false, source: 'global_off' });
  });

  it('404s for an unknown studio', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/super-admin/organizations/nope/features');
    expect(res.status).toBe(404);
  });
});
