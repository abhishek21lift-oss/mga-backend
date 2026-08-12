'use strict';
// lib/activityLog.js — the shared fire-and-forget audit helper, extended for
// the business-write audit trail with organization_id and an optional
// oldData parameter. Every existing caller (profile, PAR-Q, consent, login)
// passes only the first five positional arguments, so both additions have
// to be provably additive: the same pool mock pattern upiPayments.flow.test.js
// uses, so the INSERT's actual column list and parameter order are what get
// asserted, not just the return value.

const state = { log: [] };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    state.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 1 };
  }),
}));

const pool = require('../db/pool');
const { logActivity } = require('../lib/activityLog');

beforeEach(() => { state.log = []; pool.query.mockClear(); });

function req(overrides = {}) {
  return {
    user: { id: 'user-1', name: 'Priya', organization_id: 'org-1' },
    ip: '10.0.0.1',
    headers: { 'user-agent': 'jest' },
    ...overrides,
  };
}

describe('logActivity', () => {
  it('inserts into activity_log with the full column list, in order', async () => {
    await logActivity(req(), 'client.create', 'pt_client', 'client-9', { name: 'Rahul' });
    expect(state.log).toHaveLength(1);
    expect(state.log[0].sql).toContain(
      'INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent, organization_id)'
    );
  });

  it('stamps organization_id from req.user, not invented or left to a caller to pass', async () => {
    await logActivity(req(), 'client.create', 'pt_client', 'client-9', { name: 'Rahul' });
    const [, , , , , , , , , orgId] = state.log[0].params;
    expect(orgId).toBe('org-1');
  });

  it('is null for an org-less actor (the platform super-admin) rather than throwing', async () => {
    await logActivity(req({ user: { id: 'super-1', name: 'Admin', organization_id: null } }), 'org.suspend', 'organization', 'org-2', {});
    const [, , , , , , , , , orgId] = state.log[0].params;
    expect(orgId).toBeNull();
  });

  it('carries oldData as old_data when given, and stays null when omitted (every pre-existing caller)', async () => {
    await logActivity(req(), 'client.update', 'pt_client', 'client-9', { name: 'Rahul K' }, { name: 'Rahul' });
    const [, , , , , oldData, newData] = state.log[0].params;
    expect(JSON.parse(oldData)).toEqual({ name: 'Rahul' });
    expect(JSON.parse(newData)).toEqual({ name: 'Rahul K' });

    state.log = [];
    await logActivity(req(), 'profile.update', 'user', 'user-1', { name: 'x' });
    const [, , , , , oldDataOmitted] = state.log[0].params;
    expect(oldDataOmitted).toBeNull();
  });

  it('still tags impersonated writes with who was really behind them', async () => {
    await logActivity(
      req({ impersonation: { by: 'super-1', byName: 'Ops' } }),
      'client.update', 'pt_client', 'client-9', { name: 'Rahul' }
    );
    const [, , , , , , newData] = state.log[0].params;
    const parsed = JSON.parse(newData);
    expect(parsed._impersonated_by).toBe('super-1');
    expect(parsed._impersonated_by_name).toBe('Ops');
  });

  it('never throws — a failed audit write must not fail the request it describes', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(logActivity(req(), 'client.create', 'pt_client', 'client-9', {})).resolves.toBeUndefined();
  });
});
