// Propose → confirm → execute.
//
// The registry test covers who gets resolved. This one covers the lifecycle,
// where the dangerous failures live: running a plan twice, running a plan
// whose recipient list moved since it was read, running somebody else's plan.
// Every one of them ends with real WhatsApp messages reaching real clients,
// and none of them throws on the way.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

let mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));

const mockSendText = jest.fn();
jest.mock('../services/whatsappDelivery', () => ({
  sendText: (...a) => mockSendText(...a),
  sendTemplate: jest.fn(),
  twilioWhatsappConfigured: () => true,
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/ai', require('../modules/ai-actions/ai-actions.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const CLIENT = (i) => ({
  id: `c${i}`, name: `Client ${i}`, mobile: `99900000${i}`,
  balance_amount: 1000 * i, pt_end_date: '2026-09-01', days_left: 3,
});

/** Queries in order: resolve → insert plan. */
function mockPlanFlow(clients) {
  pool.query
    .mockResolvedValueOnce({ rows: clients })
    .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: new Date(Date.now() + 300000) }] });
}

const future = () => new Date(Date.now() + 300000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

beforeEach(() => {
  pool.query.mockReset();
  mockSendText.mockReset();
  mockSendText.mockResolvedValue({ status: 'sent' });
  mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
});

describe('planning', () => {
  test('describes the run without sending anything', async () => {
    mockPlanFlow([CLIENT(1), CLIENT(2)]);
    const res = await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.plan_id).toBe('plan-1');
    expect(res.body.data.outward).toBe(true);
    expect(res.body.data.sample_message).toContain('Client 1');
    // The whole point: planning is read-only.
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a trainer is refused', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
    const res = await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an unknown action is a 404, not a crash', async () => {
    const res = await request(app()).post('/api/ai/actions/drop_everything/plan').send({});
    expect(res.status).toBe(404);
  });

  test('the stored plan is stamped with the caller and their org', async () => {
    mockPlanFlow([CLIENT(1)]);
    await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});
    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    expect(insert[1][0]).toBe('org-1');
    expect(insert[1][1]).toBe('u1');
  });
});

describe('executing', () => {
  const planRow = (over = {}) => ({
    rows: [{
      id: 'plan-1',
      action_id: 'dues_reminders',
      // sha256 over `${id}:${body}` lines, sorted — recomputed by the route.
      fingerprint: 'WILL-BE-SET',
      params: { min_balance: 1 },
      consumed_at: null,
      expires_at: future(),
      ...over,
    }],
  });

  /** Run a plan, then execute it, so the fingerprint is the real one. */
  async function planThenExecute({ executeClients, planOver = {}, claimRows = 1 } = {}) {
    const a = app();
    mockPlanFlow([CLIENT(1), CLIENT(2)]);
    const planned = await request(a).post('/api/ai/actions/dues_reminders/plan').send({});
    const storedFingerprint = pool.query.mock.calls
      .find(([sql]) => /INSERT INTO ai_action_plans/.test(sql))[1][3];

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce(planRow({ fingerprint: storedFingerprint, ...planOver }))
      .mockResolvedValueOnce({ rows: executeClients })   // re-resolve
      .mockResolvedValueOnce({ rowCount: claimRows })     // atomic claim
      .mockResolvedValueOnce({ rows: [] });               // store result

    const res = await request(a)
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: planned.body.data.plan_id });
    return res;
  }

  test('sends when the world has not moved', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(2);
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });

  // The one that matters most. A client enrolled between reading and
  // confirming: executing the fresh list would message somebody the operator
  // never saw. Refusing is the only honest answer.
  test('refuses when the recipient list changed since it was read', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2), CLIENT(3)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses when somebody dropped out of the list', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  // Two taps on Confirm. The claim UPDATE matches no row the second time.
  test('refuses a second run of the same plan', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)], claimRows: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_run');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses a plan already marked consumed', async () => {
    const res = await planThenExecute({
      executeClients: [CLIENT(1), CLIENT(2)],
      planOver: { consumed_at: new Date().toISOString() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_run');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses an expired plan', async () => {
    const res = await planThenExecute({
      executeClients: [CLIENT(1), CLIENT(2)],
      planOver: { expires_at: past() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('expired');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('the claim is conditional on not already being consumed', async () => {
    await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    const claim = pool.query.mock.calls.find(([sql]) => /UPDATE ai_action_plans SET consumed_at/.test(sql));
    expect(String(claim[0])).toMatch(/WHERE id = \$1 AND consumed_at IS NULL/);
  });

  test('a plan is looked up by its owner, not just by id', async () => {
    await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    const lookup = pool.query.mock.calls.find(([sql]) => /FROM ai_action_plans/.test(sql));
    expect(String(lookup[0])).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(lookup[1][1]).toBe('u1');
  });

  test('someone else\'s plan is not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-x' });
    expect(res.status).toBe(404);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a plan cannot be redirected at a different action', async () => {
    pool.query.mockResolvedValueOnce(planRow({ action_id: 'renewal_reminders' }));
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-1' });
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a trainer cannot execute even with a valid plan id', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-1' });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('execute requires a plan — there is no unconfirmed path', async () => {
    const res = await request(app()).post('/api/ai/actions/dues_reminders/execute').send({});
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('reports not_configured honestly instead of counting it as sent', async () => {
    mockSendText.mockResolvedValue({ status: 'not_configured' });
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(0);
    expect(res.body.data.tally.not_configured).toBe(2);
  });
});
