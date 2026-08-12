jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const { runTools } = require('../lib/ai/tools');

function reqAs(role, overrides = {}) {
  return { user: { id: 'usr-1', role, organization_id: 'org-1', trainer_id: 'trn-1', ...overrides } };
}

describe('AI Coach tool-calling (runTools)', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('runs nothing for a message that matches no tool', async () => {
    const result = await runTools(reqAs('admin'), 'What is a good warm-up routine?');
    expect(result.toolNames).toEqual([]);
    expect(result.contextText).toBe('');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('client_stats: triggers on "how many active clients" and formats the result', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ active: '12', inactive: '3', frozen: '1', expiring_soon: '2', total: '16' }],
    });
    const result = await runTools(reqAs('manager'), 'How many active clients do we have?');
    expect(result.toolNames).toContain('Client Stats');
    expect(result.contextText).toMatch(/16 total.*12 active/s);
    expect(pool.query).toHaveBeenCalledTimes(1);
    // Tenant-scoped: organization_id must be in the query params.
    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain('org-1');
  });

  it('find_client: extracts the name and reports "not found" on an empty result', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await runTools(reqAs('trainer'), 'Can you look up the client named Priya Sharma?');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/No client matching "Priya Sharma"/);
  });

  it('find_client: does not trigger on an unrelated mention of the word "client"', async () => {
    const result = await runTools(reqAs('admin'), 'What should I tell a new client about hydration?');
    expect(result.toolNames).not.toContain('Client Lookup');
  });

  // Regression: the original implementation only matched the literal phrasing
  // "client named X", so this — how people actually ask — ran no lookup at
  // all and the coach claimed it had no information about a real, onboarded
  // client.
  it('find_client: triggers on "Tell me about <Name>" and injects the record', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        name: 'Prakhar Sharma', status: 'active', package_type: '3 Month PT',
        trainer_name: 'Ravi', balance_amount: '0', paid_amount: '30000',
        final_amount: '30000', pt_start_date: null, pt_end_date: null, mobile: '9999999999',
      }],
    });
    const result = await runTools(reqAs('admin'), 'Tell me about Prakhar Sharma');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/Prakhar Sharma/);
    expect(result.contextText).toMatch(/status: active/);
  });

  it('find_client: triggers on a bare capitalised name anywhere in the question', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        name: 'Prakhar Sharma', status: 'active', package_type: null, trainer_name: null,
        balance_amount: '5000', paid_amount: '0', final_amount: '5000',
        pt_start_date: null, pt_end_date: null, mobile: null,
      }],
    });
    const result = await runTools(reqAs('admin'), 'Any update on Prakhar Sharma?');
    expect(result.toolNames).toContain('Client Lookup');
    expect(result.contextText).toMatch(/Prakhar Sharma/);
  });

  it('find_client: stays silent when a guessed name matches no client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await runTools(reqAs('admin'), 'Tell me about Progressive Overload');
    // Ran a lookup, found nothing, and said nothing — the model should answer
    // the training question normally rather than explain a failed name search.
    expect(result.toolNames).not.toContain('Client Lookup');
    expect(result.contextText).toBe('');
  });

  it('find_client: scopes the lookup to the caller organization', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('admin'), 'Tell me about Prakhar Sharma');
    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain('org-1');
  });

  it('find_client: a trainer only sees their own roster', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await runTools(reqAs('trainer'), 'Tell me about Prakhar Sharma');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/trainer_id = \$\d/);
    expect(params).toContain('trn-1');
  });

  it('revenue_summary: denies a trainer role without running the query', async () => {
    const result = await runTools(reqAs('trainer'), 'What was our revenue this month?');
    expect(result.toolNames).toContain('Revenue');
    expect(result.contextText).toMatch(/not permitted to view this data/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('revenue_summary: runs for an admin and formats INR', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total_revenue: '45000', total_payments: '9' }] });
    const result = await runTools(reqAs('admin'), 'What was our revenue this month?');
    expect(result.contextText).toMatch(/₹45,000/);
    expect(result.contextText).toMatch(/9 payments/);
  });

  it('search_exercises: extracts a known muscle keyword', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ name: 'Barbell Row', equipment: 'barbell', difficulty: 'intermediate' }],
    });
    const result = await runTools(reqAs('trainer'), 'What exercises target back for a beginner?');
    expect(result.toolNames).toContain('Exercise Search');
    expect(result.contextText).toMatch(/Barbell Row/);
  });

  it('caps at 2 tools even if more than 2 patterns match', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    // "clients", "attendance" and "trainers" all appear — only the first 2 (by TOOLS array order) should run.
    const result = await runTools(reqAs('admin'), 'How many active clients came in for attendance and how many trainers do we have?');
    expect(result.toolNames.length).toBeLessThanOrEqual(2);
  });
});
