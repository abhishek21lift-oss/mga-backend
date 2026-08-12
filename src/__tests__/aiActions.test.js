// The assistant is not in the write path, and this is where that is enforced.
//
// Everything asserted here is a property that fails silently if it breaks.
// Nothing throws when an action messages one client too many, or messages the
// same twelve people twice, or reports "sent" for a run where nothing left the
// building. You find out from a client, later.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));

const mockSendText = jest.fn();
const mockConfigured = jest.fn(() => true);
jest.mock('../services/whatsappDelivery', () => ({
  sendText: (...a) => mockSendText(...a),
  sendTemplate: jest.fn(),
  twilioWhatsappConfigured: () => mockConfigured(),
}));

const { findAction, canRun, listFor, deliver, clampInt, MAX_RECIPIENTS } =
  require('../modules/ai-actions/registry');

const admin = { id: 'u1', role: 'admin', organization_id: 'org-1' };
const trainer = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
const reqAs = (user, body = {}) => ({ user, body, headers: {} });

beforeEach(() => {
  mockQuery.mockReset();
  mockSendText.mockReset();
  mockConfigured.mockReturnValue(true);
});

describe('who may run an action', () => {
  test('a trainer is not offered outward actions, and cannot run one', () => {
    expect(listFor(trainer)).toEqual([]);
    expect(canRun(findAction('renewal_reminders'), trainer)).toBe(false);
  });

  test('an admin is', () => {
    expect(listFor(admin).map((a) => a.id).sort())
      .toEqual(['dues_reminders', 'renewal_reminders']);
    expect(canRun(findAction('renewal_reminders'), admin)).toBe(true);
  });

  test('every offered action declares that it leaves the building', () => {
    // The confirmation UI keys off this. An outward action mislabelled as
    // internal is one that sends without the operator being warned.
    for (const a of listFor(admin)) expect(a.outward).toBe(true);
  });
});

describe('parameters are clamped, not trusted', () => {
  test('clampInt bounds and falls back', () => {
    expect(clampInt('3650', { min: 1, max: 90, fallback: 7 })).toBe(90);
    expect(clampInt('0', { min: 1, max: 90, fallback: 7 })).toBe(1);
    expect(clampInt('banana', { min: 1, max: 90, fallback: 7 })).toBe(7);
    expect(clampInt(undefined, { min: 1, max: 90, fallback: 7 })).toBe(7);
  });

  test('a caller cannot widen the renewal window past 90 days', () => {
    expect(findAction('renewal_reminders').normalize({ days: 100000 })).toEqual({ days: 90 });
  });

  test('a caller cannot drop the dues floor below 1', () => {
    expect(findAction('dues_reminders').normalize({ min_balance: -5 })).toEqual({ min_balance: 1 });
  });
});

describe('recipients come from the server, scoped to the org', () => {
  test('a tenant user gets an organization_id filter and their own org id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('renewal_reminders').resolve(reqAs(admin), { days: 7 });

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(values).toEqual([7, 'org-1']);
  });

  test('ids in the request body are ignored entirely', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const req = reqAs(admin, { client_ids: ['someone-elses-client'], recipients: ['x'] });
    await findAction('dues_reminders').resolve(req, { min_balance: 1 });

    const [, values] = mockQuery.mock.calls[0];
    // Only the clamped parameter and the org id — nothing caller-supplied.
    expect(values).toEqual([1, 'org-1']);
    expect(JSON.stringify(mockQuery.mock.calls[0])).not.toContain('someone-elses-client');
  });

  test('an org-less tenant user filters on NULL, which matches nobody', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('dues_reminders').resolve(
      reqAs({ id: 'u9', role: 'admin', organization_id: null }), { min_balance: 1 },
    );
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(values[1]).toBeNull();
  });

  test('the recipient list is capped', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('renewal_reminders').resolve(reqAs(admin), { days: 7 });
    expect(mockQuery.mock.calls[0][0]).toMatch(new RegExp(`LIMIT ${MAX_RECIPIENTS}\\b`));
  });
});

describe('the plan tells the truth before anybody confirms', () => {
  test('an unconfigured channel is a warning on the plan, not a surprise after', async () => {
    // This codebase already shipped one endpoint that answered "sent" whether
    // or not anything left the building. Not twice.
    mockConfigured.mockReturnValue(false);
    mockQuery.mockResolvedValue({ rows: [{ id: 'c1', name: 'A', mobile: '9990000001', balance_amount: 500 }] });

    const { warnings } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(warnings.join(' ')).toMatch(/not configured/i);
  });

  test('clients with no mobile number are excluded and counted', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'c1', name: 'Has Phone', mobile: '9990000001', balance_amount: 500 },
        { id: 'c2', name: 'No Phone', mobile: null, balance_amount: 900 },
      ],
    });
    const { recipients, warnings } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(recipients.map((r) => r.id)).toEqual(['c1']);
    expect(warnings.join(' ')).toMatch(/1 matching client has no mobile number/);
  });

  test('each recipient carries the exact message that will be sent to them', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'c1', name: 'Ajeet', mobile: '9990000001', balance_amount: 2500 }],
    });
    const { recipients } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(recipients[0].body).toContain('Ajeet');
    expect(recipients[0].body).toContain('₹2,500');
  });
});

describe('delivery reports what happened', () => {
  test('not_configured is passed through as itself, not as sent and not as failed', async () => {
    mockSendText.mockResolvedValue({ status: 'not_configured', provider_id: null });
    const out = await deliver([{ id: 'c1', name: 'A', mobile: '999', body: 'hi' }]);
    expect(out[0].status).toBe('not_configured');
  });

  test('one failure does not lose the rest of the run', async () => {
    mockSendText
      .mockResolvedValueOnce({ status: 'sent' })
      .mockResolvedValueOnce({ status: 'failed', error: 'bad number' })
      .mockResolvedValueOnce({ status: 'sent' });

    const out = await deliver([
      { id: 'a', name: 'A', mobile: '1', body: 'x' },
      { id: 'b', name: 'B', mobile: '2', body: 'x' },
      { id: 'c', name: 'C', mobile: '3', body: 'x' },
    ]);
    expect(out.map((r) => r.status)).toEqual(['sent', 'failed', 'sent']);
  });

  test('sends to exactly the resolved numbers, once each', async () => {
    mockSendText.mockResolvedValue({ status: 'sent' });
    await deliver([
      { id: 'a', name: 'A', mobile: '9990000001', body: 'one' },
      { id: 'b', name: 'B', mobile: '9990000002', body: 'two' },
    ]);
    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText).toHaveBeenCalledWith({ to: '9990000001', body: 'one' });
    expect(mockSendText).toHaveBeenCalledWith({ to: '9990000002', body: 'two' });
  });
});
