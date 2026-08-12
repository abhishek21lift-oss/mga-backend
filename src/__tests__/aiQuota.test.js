// AI token quota resolution and the request guard.
//
// Two properties carry the module: "a row with NULL" must not collapse into
// "no row" (they mean exempt vs undecided), and the guard must fail OPEN — a
// cost control that can take the AI Suite down when its own check errors is
// worse than no cost control.
'use strict';

jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

const aiQuota = require('../lib/aiQuota');
const logger = require('../lib/logger');

/** Route each statement by shape, so tests do not depend on call ordering. */
function script({ settings, limitRows = [], usage = { tokens: 0, requests: 0 } }) {
  mockQuery.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM ai_platform_settings/.test(s)) return { rows: settings ? [settings] : [] };
    if (/FROM organization_ai_limits/.test(s)) return { rows: limitRows };
    if (/FROM ai_usage_log/.test(s)) return { rows: [{ tokens: String(usage.tokens), requests: usage.requests }] };
    return { rows: [] };
  });
}

beforeEach(() => { mockQuery.mockReset(); logger.warn.mockReset(); });

describe('limit resolution', () => {
  it('prefers an explicit per-studio cap', async () => {
    script({ settings: { default_monthly_tokens: 10000 }, limitRows: [{ monthly_tokens: '50000' }] });
    expect(await aiQuota.limitFor('org-1')).toEqual({ limit: 50000, source: 'studio' });
  });

  it('treats a row whose value is NULL as EXEMPT, not as absent', async () => {
    // Collapsing the two would silently re-apply the platform default to a
    // studio an operator deliberately exempted.
    script({ settings: { default_monthly_tokens: 10000 }, limitRows: [{ monthly_tokens: null }] });
    expect(await aiQuota.limitFor('org-1')).toEqual({ limit: null, source: 'studio' });
  });

  it('falls back to the platform default when there is no row', async () => {
    script({ settings: { default_monthly_tokens: 10000 }, limitRows: [] });
    expect(await aiQuota.limitFor('org-1')).toEqual({ limit: 10000, source: 'default' });
  });

  it('is unlimited when neither a row nor a default exists', async () => {
    script({ settings: { default_monthly_tokens: null }, limitRows: [] });
    expect(await aiQuota.limitFor('org-1')).toEqual({ limit: null, source: 'none' });
  });

  it('survives a missing settings row', async () => {
    // A database that predates migration 126 must not break AI entirely.
    script({ settings: null, limitRows: [] });
    expect(await aiQuota.limitFor('org-1')).toEqual({ limit: null, source: 'none' });
  });
});

describe('status', () => {
  it('reports usage, percentage and the over/warn flags', async () => {
    script({
      settings: { default_monthly_tokens: 1000, enforcement_enabled: true, warn_at_pct: 80 },
      limitRows: [], usage: { tokens: 850, requests: 12 },
    });
    const s = await aiQuota.statusFor('org-1');
    expect(s).toMatchObject({ tokens_used: 850, limit: 1000, used_pct: 85, over: false, warn: true });
  });

  it('measures against the calendar month, which is the unit a limit is quoted in', async () => {
    script({ settings: { default_monthly_tokens: 1000 }, usage: { tokens: 10, requests: 1 } });
    await aiQuota.statusFor('org-1');
    const usageSql = mockQuery.mock.calls.map(([s]) => String(s)).find((s) => /FROM ai_usage_log/.test(s));
    expect(usageSql).toMatch(/date_trunc\('month', now\(\)\)/);
  });

  it('never marks an exempt studio over, however much it uses', async () => {
    script({
      settings: { default_monthly_tokens: 100, enforcement_enabled: true, warn_at_pct: 80 },
      limitRows: [{ monthly_tokens: null }], usage: { tokens: 9_000_000, requests: 500 },
    });
    const s = await aiQuota.statusFor('org-1');
    expect(s).toMatchObject({ limit: null, over: false, warn: false, used_pct: null });
  });

  it('attributes usage through users, since ai_usage_log has no organization_id', async () => {
    script({ settings: {}, usage: { tokens: 0, requests: 0 } });
    await aiQuota.usedThisMonth('org-1');
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/JOIN users u ON u\.id = l\.user_id/);
  });
});

describe('the guard', () => {
  const run = async (opts) => {
    script(opts);
    let status = null; let body = null; let nexted = false;
    const req = { user: { organization_id: 'org-1', role: opts.role || 'admin' } };
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await aiQuota.requireAiQuota()(req, res, () => { nexted = true; });
    return { status, body, nexted };
  };

  it('allows an over-quota studio while enforcement is off', async () => {
    // The whole point of the switch: set limits, watch who WOULD be cut off,
    // then decide.
    const r = await run({
      settings: { default_monthly_tokens: 100, enforcement_enabled: false, warn_at_pct: 80 },
      usage: { tokens: 5000, requests: 9 },
    });
    expect(r.nexted).toBe(true);
  });

  it('refuses with 429 once enforcement is on and the cap is passed', async () => {
    const r = await run({
      settings: { default_monthly_tokens: 100, enforcement_enabled: true, warn_at_pct: 80 },
      usage: { tokens: 5000, requests: 9 },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('AI_QUOTA_EXCEEDED');
    // The numbers are on the error so a studio can be told what happened.
    expect(r.body.error).toMatchObject({ tokens_used: 5000, limit: 100 });
  });

  it('lets an under-quota studio through', async () => {
    const r = await run({
      settings: { default_monthly_tokens: 10000, enforcement_enabled: true, warn_at_pct: 80 },
      usage: { tokens: 5, requests: 1 },
    });
    expect(r.nexted).toBe(true);
  });

  it('never quota-limits a platform operator', async () => {
    const r = await run({
      settings: { default_monthly_tokens: 1, enforcement_enabled: true, warn_at_pct: 80 },
      usage: { tokens: 9999, requests: 1 }, role: 'super_admin',
    });
    expect(r.nexted).toBe(true);
  });

  it('fails OPEN when the check itself errors', async () => {
    // A cost control must not be able to take the AI Suite down. The warning
    // is how this surfaces instead.
    mockQuery.mockRejectedValue(new Error('relation "ai_platform_settings" does not exist'));
    let nexted = false;
    await aiQuota.requireAiQuota()(
      { user: { organization_id: 'org-1', role: 'admin' } },
      { status() { return this; }, json() { return this; } },
      () => { nexted = true; },
    );
    expect(nexted).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('passes a request with no organization straight through', async () => {
    let nexted = false;
    await aiQuota.requireAiQuota()({ user: {} }, {}, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
