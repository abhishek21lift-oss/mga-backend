// AI Control Centre routes.
//
// The recurring theme: cost must never be invented. A model with no configured
// rate contributes tokens and zero cost, and the response names it so the UI
// can label the total partial rather than presenting an understated figure as
// complete.
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

const TOTALS = {
  requests: 120, tokens: '450000', tokens_prompt: '300000', tokens_completion: '150000',
  studios: 8, users: 19, avg_latency_ms: 820, fallbacks: 6, cost_inr: '742.50',
};
const SETTINGS = { enforcement_enabled: false, default_monthly_tokens: null, warn_at_pct: 80 };

beforeEach(() => pool.query.mockReset());

describe('overview', () => {
  it('names the unpriced models so the cost can be labelled partial', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [TOTALS] })
      .mockResolvedValueOnce({ rows: [{ model: 'llama-free' }, { model: 'local-7b' }] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });

    const res = await request(app()).get('/api/super-admin/ai/overview');

    expect(res.status).toBe(200);
    expect(res.body.data.unpriced_models).toEqual(['llama-free', 'local-7b']);
    expect(res.body.data.cost_inr).toBe(742.5);
  });

  it('reports the fallback rate beside the volume', async () => {
    // A rising fallback rate is an availability problem, not a usage one.
    pool.query
      .mockResolvedValueOnce({ rows: [TOTALS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });
    const res = await request(app()).get('/api/super-admin/ai/overview');
    expect(res.body.data.fallback_pct).toBe(5);
  });

  it('does not divide by zero on an empty window', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...TOTALS, requests: 0, fallbacks: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });
    const res = await request(app()).get('/api/super-admin/ai/overview');
    expect(res.body.data.fallback_pct).toBe(0);
  });

  it('clamps the window', async () => {
    // days=0 clamps to the MINIMUM (1), not to the default — an explicit 0 is
    // someone asking for the narrowest window, and silently widening it to 30
    // is the bug fixed in the Security Centre's threat window.
    for (const [q, want] of [['days=7', '7'], ['days=99999', '365'], ['days=0', '1'], ['', '30'], ['days=abc', '30']]) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [TOTALS] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [SETTINGS] });
      await request(app()).get(`/api/super-admin/ai/overview?${q}`);
      expect(calls()[0].params).toEqual([want]);
    }
  });

  it('counts unpriced tokens but attributes them no cost', async () => {
    // COALESCE on the rate, LEFT JOIN on the rate table: the row survives and
    // adds zero rather than dropping out and understating the tokens too.
    pool.query
      .mockResolvedValueOnce({ rows: [TOTALS] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SETTINGS] });
    await request(app()).get('/api/super-admin/ai/overview');
    const sql = calls()[0].sql;
    expect(sql).toMatch(/LEFT JOIN ai_model_rates/);
    expect(sql).toMatch(/COALESCE\(r\.prompt_per_1k_inr, 0\)/);
  });
});

describe('by studio', () => {
  const ROW = {
    organization_id: 'o1', organization_name: 'Iron House', plan_code: 'growth',
    requests: 40, tokens: '120000', cost_inr: '210.00', tokens_this_month: '80000',
    last_used_at: new Date().toISOString(), monthly_tokens: null, has_own_limit: false,
  };

  it('applies the same limit precedence the guard uses', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [
        { ...ROW, has_own_limit: true, monthly_tokens: '50000' },
        { ...ROW, organization_id: 'o2', has_own_limit: true, monthly_tokens: null },
        { ...ROW, organization_id: 'o3', has_own_limit: false },
      ] })
      .mockResolvedValueOnce({ rows: [{ ...SETTINGS, default_monthly_tokens: '10000' }] });

    const res = await request(app()).get('/api/super-admin/ai/by-studio');
    const [own, exempt, dflt] = res.body.data;

    expect(own).toMatchObject({ limit: 50000, limit_source: 'studio', over: true });
    // A row with NULL is an exemption, so it is never over.
    expect(exempt).toMatchObject({ limit: null, limit_source: 'studio', over: false });
    expect(dflt).toMatchObject({ limit: 10000, limit_source: 'default', over: true });
  });

  it('compares the limit against THIS MONTH, not against the display window', async () => {
    // The window may be 90 days; a monthly allowance measured over it would
    // report studios as over when they are not.
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [SETTINGS] });
    await request(app()).get('/api/super-admin/ai/by-studio?days=90');
    expect(calls()[0].sql).toMatch(/FILTER \(WHERE l\.created_at >= date_trunc\('month', now\(\)\)\)/);
  });

  it('excludes deleted studios', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [SETTINGS] });
    await request(app()).get('/api/super-admin/ai/by-studio');
    expect(calls()[0].sql).toMatch(/o\.status <> 'deleted'/);
  });
});

describe('settings', () => {
  it('records how many studios are already over when enforcement is switched on', async () => {
    // The consequential flip: it can start refusing requests immediately, and
    // the count is not reconstructible afterwards.
    pool.query
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValueOnce({ rows: [{ ...SETTINGS, enforcement_enabled: true, default_monthly_tokens: '10000' }] })
      .mockResolvedValueOnce({ rows: [{ n: 4 }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).put('/api/super-admin/ai/settings').send({ enforcement_enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.studios_already_over).toBe(4);
    expect(JSON.stringify(call(/INSERT INTO activity_log/).params)).toMatch(/"studios_already_over":4/);
  });

  it('does not run the blast-radius count when merely switching enforcement off', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app()).put('/api/super-admin/ai/settings').send({ enforcement_enabled: false });
    expect(res.body.studios_already_over).toBeNull();
  });

  it('accepts null to clear the platform default back to unlimited', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValueOnce({ rows: [SETTINGS] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app()).put('/api/super-admin/ai/settings').send({ default_monthly_tokens: null });
    expect(res.status).toBe(200);
    expect(call(/UPDATE ai_platform_settings/).params[0]).toBeNull();
  });

  it('rejects nonsense values', async () => {
    for (const body of [{ default_monthly_tokens: -5 }, { default_monthly_tokens: 'lots' },
      { warn_at_pct: 0 }, { warn_at_pct: 101 }, {}]) {
      pool.query.mockReset();
      const res = await request(app()).put('/api/super-admin/ai/settings').send(body);
      expect(res.status).toBe(400);
      expect(call(/UPDATE ai_platform_settings/)).toBeUndefined();
    }
  });
});

describe('model rates', () => {
  it('upserts a rate', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ model: 'gpt-x' }] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).put('/api/super-admin/ai/rates/gpt-x')
      .send({ provider: 'openrouter', prompt_per_1k_inr: 2.5, completion_per_1k_inr: 7.5 });
    expect(res.status).toBe(200);
    expect(call(/INSERT INTO ai_model_rates/).sql).toMatch(/ON CONFLICT \(model\) DO UPDATE/);
  });

  it('rejects a negative rate', async () => {
    const res = await request(app()).put('/api/super-admin/ai/rates/gpt-x')
      .send({ prompt_per_1k_inr: -1, completion_per_1k_inr: 1 });
    expect(res.status).toBe(400);
    expect(call(/INSERT INTO ai_model_rates/)).toBeUndefined();
  });
});

describe('per-studio limits', () => {
  it('sets a cap with the operator and reason recorded', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'o1', name: 'Iron House' }] })
      .mockResolvedValueOnce({ rows: [{ organization_id: 'o1', monthly_tokens: '50000', reason: 'fair use' }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app()).put('/api/super-admin/organizations/o1/ai-limit')
      .send({ monthly_tokens: 50000, reason: 'fair use' });

    expect(res.status).toBe(200);
    expect(call(/INSERT INTO organization_ai_limits/).params).toContain('Owner');
  });

  it('accepts null as an explicit exemption', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'o1', name: 'Iron House' }] })
      .mockResolvedValueOnce({ rows: [{ monthly_tokens: null }] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app()).put('/api/super-admin/organizations/o1/ai-limit')
      .send({ monthly_tokens: null, reason: 'enterprise agreement' });
    expect(res.status).toBe(200);
    expect(call(/INSERT INTO organization_ai_limits/).params[1]).toBeNull();
  });

  it('404s for an unknown studio', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).put('/api/super-admin/organizations/nope/ai-limit').send({ monthly_tokens: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects a negative cap', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'o1', name: 'X' }] });
    const res = await request(app()).put('/api/super-admin/organizations/o1/ai-limit').send({ monthly_tokens: -1 });
    expect(res.status).toBe(400);
  });

  it('clears a limit so the studio falls back to the default', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ monthly_tokens: '5000' }] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/organizations/o1/ai-limit');
    expect(res.status).toBe(200);
    expect(call(/INSERT INTO activity_log/).params).toEqual(expect.arrayContaining(['ai_limit_cleared']));
  });

  it('404s when clearing a limit that was never set', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).delete('/api/super-admin/organizations/o1/ai-limit');
    expect(res.status).toBe(404);
  });
});
