'use strict';
// pool.withOrgScope — the transaction wrapper TENANT-RLS-PLAN.md calls for:
// BEGIN, set app.org_id via set_config(), run the query, COMMIT (or
// ROLLBACK on failure). Tested directly against a fake client so it needs
// neither a real database nor TENANT_RLS_ENFORCE turned on — the pool.query
// gating itself is covered by tenantRlsFlag.test.js, which reads the source
// rather than exercising a live connection.

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'a'.repeat(64);

const pool = require('../db/pool');

function fakeClient() {
  const calls = [];
  return {
    calls,
    query: jest.fn((...args) => { calls.push(args); return Promise.resolve({ rows: [] }); }),
  };
}

describe('pool.withOrgScope', () => {
  it('runs BEGIN, set_config, the query, then COMMIT, in that order', async () => {
    const client = fakeClient();
    const run = jest.fn(() => client.query('SELECT 1'));

    await pool.withOrgScope(client, 'org-42', run);

    // The run() call is included among client.calls because it also goes
    // through client.query — assert the surrounding sequence by looking at
    // just the wrapper's own three statements plus wherever run() landed.
    const texts = client.calls.map((c) => c[0]);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe('SELECT set_config($1, $2, true)');
    expect(client.calls[1][1]).toEqual(['app.org_id', 'org-42']);
    expect(texts[2]).toBe('SELECT 1'); // run()'s own query
    expect(texts[3]).toBe('COMMIT');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never string-builds the org id into SQL text — always a bind parameter', async () => {
    const client = fakeClient();
    await pool.withOrgScope(client, "org'; DROP TABLE pt_clients; --", () => Promise.resolve());
    const setConfigCall = client.calls.find((c) => c[0] === 'SELECT set_config($1, $2, true)');
    expect(setConfigCall).toBeDefined();
    expect(setConfigCall[1][1]).toBe("org'; DROP TABLE pt_clients; --");
    // The hostile string appears only as a parameter value, never inside
    // any statement text this wrapper sends.
    for (const [text] of client.calls) {
      expect(text).not.toContain('DROP TABLE');
    }
  });

  it('returns what run() returns', async () => {
    const client = fakeClient();
    const result = await pool.withOrgScope(client, 'org-1', () => Promise.resolve({ rows: [{ id: 1 }] }));
    expect(result).toEqual({ rows: [{ id: 1 }] });
  });

  it('rolls back and rethrows when run() fails, and never commits', async () => {
    const client = fakeClient();
    const boom = new Error('query failed');
    await expect(
      pool.withOrgScope(client, 'org-1', () => Promise.reject(boom))
    ).rejects.toBe(boom);

    const texts = client.calls.map((c) => c[0]);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });

  it('rolls back and rethrows the original error even if ROLLBACK itself fails', async () => {
    const client = fakeClient();
    client.query = jest.fn((text) => {
      if (text === 'ROLLBACK') return Promise.reject(new Error('connection already closed'));
      return Promise.resolve({ rows: [] });
    });
    const boom = new Error('query failed');
    await expect(
      pool.withOrgScope(client, 'org-1', () => Promise.reject(boom))
    ).rejects.toBe(boom);
  });
});
