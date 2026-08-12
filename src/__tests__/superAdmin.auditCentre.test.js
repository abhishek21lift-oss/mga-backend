jest.mock('../db/pool', () => ({ query: jest.fn(), totalCount: 3, idleCount: 2, waitingCount: 0 }));
// audit() and every super-admin read moved to the platform pool (migration 163).
// Same mock object, so assertions about what SQL a handler ran keep working;
// which pool it used is asserted separately, in platformPool.tiers.test.js.
jest.mock('../db/platformPool', () => require('../db/pool'));
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

/** Grabs the SQL+params of the first query whose text matches `re`. */
function callMatching(re) {
  return pool.query.mock.calls.find(([sql]) => re.test(sql));
}

beforeEach(() => pool.query.mockReset());

describe('Audit Centre — GET /audit', () => {
  it('returns rows plus a real total so the UI can paginate', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', action: 'org_updated' }] })  // page
      .mockResolvedValueOnce({ rows: [{ total: 137 }] });                       // count

    const res = await request(app()).get('/api/super-admin/audit');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.paging).toEqual({ limit: 50, offset: 0, total: 137, count: 1 });
  });

  it('selects old_data alongside new_data — the point of the audit view is what changed', async () => {
    pool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await request(app()).get('/api/super-admin/audit');

    const [sql] = callMatching(/FROM activity_log/);
    expect(sql).toMatch(/a\.old_data/);
    expect(sql).toMatch(/a\.new_data/);
    expect(sql).toMatch(/a\.user_agent/);
  });

  it('parameterises every filter rather than interpolating them', async () => {
    pool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await request(app())
      .get('/api/super-admin/audit')
      .query({ action: 'org_updated', entity_type: 'organization', user_id: 'u1',
               org_id: '11111111-1111-1111-1111-111111111111',
               from: '2026-01-01', to: '2026-02-01', q: 'Acme' });

    const [sql, params] = callMatching(/ORDER BY a\.created_at DESC/);
    // 7 filters + limit + offset. If a value were interpolated the count drops.
    expect(params).toHaveLength(9);
    expect(params).toEqual(expect.arrayContaining(['org_updated', 'organization', 'u1', '%Acme%']));
    expect(sql).not.toMatch(/Acme/);      // the value must live in params, not the SQL
    expect(sql).not.toMatch(/org_updated/);
  });

  it('treats `to` as an inclusive day, not midnight at its start', async () => {
    pool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await request(app()).get('/api/super-admin/audit').query({ to: '2026-02-01' });

    const [sql] = callMatching(/ORDER BY a\.created_at DESC/);
    // Asking for activity "to the 1st" must include everything logged on the 1st.
    expect(sql).toMatch(/INTERVAL '1 day'/);
  });

  it('caps limit so one request cannot pull the whole table', async () => {
    pool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await request(app()).get('/api/super-admin/audit').query({ limit: 99999 });

    const [, params] = callMatching(/ORDER BY a\.created_at DESC/);
    expect(params[params.length - 2]).toBe(200);
  });
});

describe('Audit Centre — GET /audit/export', () => {
  const row = {
    id: 'a1', user_id: 'u1', user_name: 'Owner', action: 'org_updated',
    entity_type: 'organization', entity_id: 'o1',
    old_data: { status: 'trial' }, new_data: { status: 'active' },
    ip_address: '1.2.3.4', user_agent: 'Mozilla/5.0', created_at: new Date('2026-02-01T10:00:00Z'),
    organization_name: 'Acme Studio',
  };

  it('emits CSV with a header and the previous/new values', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/api/super-admin/audit/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text).toMatch(/Previous Value/);
    expect(res.text).toMatch(/\{""status"":""trial""\}/);   // JSON, CSV-escaped
    expect(res.text).toMatch(/Acme Studio/);
  });

  it('neutralises spreadsheet formula injection from logged values', async () => {
    // An attacker-controlled name that Excel would otherwise execute on open.
    pool.query.mockResolvedValueOnce({ rows: [{ ...row, user_name: '=cmd|calc!A1' }] })
              .mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/api/super-admin/audit/export');

    expect(res.text).toMatch(/"'=cmd\|calc!A1"/);   // prefixed with ' so it stays inert
  });

  it('records the export itself in the audit trail', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValue({ rows: [] });
    await request(app()).get('/api/super-admin/audit/export');

    const insert = callMatching(/INSERT INTO activity_log/);
    expect(insert).toBeDefined();
    expect(insert[1]).toEqual(expect.arrayContaining(['audit_exported']));
  });

  it('bounds the export so it cannot stream an unbounded table', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    await request(app()).get('/api/super-admin/audit/export');

    const [sql, params] = callMatching(/FROM activity_log[\s\S]*LIMIT/);
    expect(sql).toMatch(/LIMIT \$\d+/);
    expect(params[params.length - 1]).toBe(10000);
  });
});

describe('System Health — GET /system-health', () => {
  it('reports the database up with a measured latency', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{}] })                                              // SELECT 1
      .mockResolvedValueOnce({ rows: [{ applied: 120, latest: '120_x.sql', applied_at: null }] })
      .mockResolvedValueOnce({ rows: [{ bytes: '8068119' }] })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] });                                       // errors 24h

    const res = await request(app()).get('/api/super-admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.database.status).toBe('up');
    expect(typeof res.body.database.latency_ms).toBe('number');
    expect(res.body.database.size_bytes).toBe(8068119);
    expect(res.body.migrations.applied).toBe(120);
    expect(res.body.errors_24h).toBe(2);
    expect(res.body.process.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('still answers 200 with status=down when the database is unreachable', async () => {
    // Health must render during an outage — that is exactly when it is opened.
    pool.query.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app()).get('/api/super-admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.database.status).toBe('down');
    expect(res.body.database.error).toMatch(/ECONNREFUSED/);
  });
});
