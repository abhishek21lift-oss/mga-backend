// /api/settings — V-06, the largest single defect in TENANT_SECURITY_AUDIT.md.
//
// Every handler in routes/settings.js read and wrote `system_settings`, one
// global key/value table with no organization_id. All six live studios shared
// one studio name, one address, one currency, one timezone, one set of check-in
// and geofence settings, one set of role permissions, and one list of branches.
// GET /api/settings returned the platform's whole configuration to any
// authenticated user; every write applied to everybody; DELETE /branches/:id
// deleted somebody else's branch.
//
// Migration 167 adds `organization_settings` keyed (organization_id, key) and
// gives `branches` an organization_id. These tests pin that the routes now use
// them, per verb, with the five-step matrix:
//
//     Tenant A writes → A reads it → B cannot read → B cannot update →
//     B cannot delete
//
// Asserted against the SQL that reaches the database rather than only status
// codes: a 404 can come from an empty fixture as easily as from a working
// predicate, and only one of those is the thing under test.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [] });
    if (/FROM organization_settings/i.test(text)) return { rows: mockRows.settings, rowCount: mockRows.settings.length };
    if (/FROM branches/i.test(text) || /UPDATE branches/i.test(text) || /INSERT INTO branches/i.test(text)) {
      return { rows: mockRows.branches, rowCount: mockRows.branches.length };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' })),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/settings', require('../routes/settings'));
  return a;
}

beforeEach(() => {
  mockLog.length = 0;
  mockRows = {
    settings: [{ key: 'gym_name', value: 'Studio A Gym', type: 'string', description: null, updated_at: null }],
    branches: [{ id: 'br-1', name: 'A Main', location: 'Andheri', status: 'active' }],
  };
  mockUser = { id: 'u-a', role: 'admin', organization_id: ORG_A };
});

const find = (re) => mockLog.find((q) => re.test(q.sql));
const asTenantB = () => { mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B }; };

describe('settings are per studio, not global', () => {
  test('GET / reads organization_settings scoped to the caller', async () => {
    const res = await request(app()).get('/api/settings');
    expect(res.status).toBe(200);
    const q = find(/FROM organization_settings/i);
    expect(q.sql).toMatch(/WHERE organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('GET / no longer touches the global system_settings table', async () => {
    // The whole point. If this regresses, every studio is reading every other
    // studio's configuration again.
    await request(app()).get('/api/settings');
    expect(mockLog.some((q) => /system_settings/i.test(q.sql))).toBe(false);
  });

  test('PUT / writes only into the caller organization', async () => {
    await request(app()).put('/api/settings').send({ gym_name: 'Renamed', currency: 'USD' });
    const q = find(/INSERT INTO organization_settings/i);
    expect(q.sql).toMatch(/ON CONFLICT \(organization_id, key\)/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('tenant B writing the same key targets its own organization', async () => {
    asTenantB();
    await request(app()).put('/api/settings').send({ gym_name: 'B Gym' });
    expect(find(/INSERT INTO organization_settings/i).params[0]).toBe(ORG_B);
  });

  test('a caller with no studio is refused rather than served a global view', async () => {
    // Falling back to a platform-wide read is exactly what this file used to
    // do, and it is the bug — so the fallback must not exist even for a
    // super admin.
    mockUser = { id: 'u-sa', role: 'super_admin', organization_id: null };
    const res = await request(app()).get('/api/settings');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORG_REQUIRED');
    expect(find(/FROM organization_settings/i)).toBeUndefined();
  });

  test('the non-admin prefix filter still applies, on top of the tenant boundary', async () => {
    mockUser = { id: 'u-r', role: 'reception', organization_id: ORG_A };
    mockRows.settings = [
      { key: 'gym_name', value: 'X', type: 'string' },
      { key: 'internal_ops_note', value: 'secret', type: 'string' },
      { key: 'geo_lat', value: '1', type: 'number' },
    ];
    const res = await request(app()).get('/api/settings');
    expect(Object.keys(res.body.settings)).toEqual(['gym_name']);
  });
});

describe('branches are a tenant-owned entity', () => {
  test('GET /branches reads the branches table, scoped', async () => {
    const res = await request(app()).get('/api/settings/branches');
    expect(res.status).toBe(200);
    const q = find(/FROM branches/i);
    expect(q.sql).toMatch(/WHERE organization_id = \$1 AND deleted_at IS NULL/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('branches no longer live as branch_% keys in a global table', async () => {
    await request(app()).get('/api/settings/branches');
    expect(mockLog.some((q) => /system_settings/i.test(q.sql))).toBe(false);
    expect(mockLog.some((q) => /branch\\_%|LIKE 'branch/i.test(q.sql))).toBe(false);
  });

  test('POST /branches stamps the caller organization', async () => {
    await request(app()).post('/api/settings/branches').send({ name: 'New', location: 'Powai' });
    const q = find(/INSERT INTO branches/i);
    expect(q.params[1]).toBe(ORG_A);
  });

  test('PUT /branches/:id carries the predicate in the UPDATE itself', async () => {
    await request(app()).put('/api/settings/branches/br-1').send({ name: 'Renamed' });
    const q = find(/UPDATE branches SET/i);
    expect(q.sql).toMatch(/WHERE id = \$1 AND organization_id = \$2 AND deleted_at IS NULL/);
    expect(q.params.slice(0, 2)).toEqual(['br-1', ORG_A]);
  });

  test("tenant B cannot update tenant A's branch", async () => {
    asTenantB();
    mockRows.branches = []; // the predicate matched nothing
    const res = await request(app()).put('/api/settings/branches/br-1').send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(find(/UPDATE branches SET/i).params[1]).toBe(ORG_B);
  });

  test("tenant B cannot delete tenant A's branch", async () => {
    asTenantB();
    mockRows.branches = [];
    const res = await request(app()).delete('/api/settings/branches/br-1');
    expect(res.status).toBe(404);
    const q = find(/UPDATE branches SET deleted_at/i);
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params[1]).toBe(ORG_B);
  });

  test('DELETE is a soft delete, so the name is freed and history survives', async () => {
    await request(app()).delete('/api/settings/branches/br-1');
    expect(find(/UPDATE branches SET deleted_at/i)).toBeDefined();
    expect(mockLog.some((q) => /DELETE FROM branches/i.test(q.sql))).toBe(false);
  });

  test('a duplicate branch name within one studio is a 409, not a 500', async () => {
    const pool = require('../db/pool');
    pool.query.mockImplementationOnce(async () => { const e = new Error('dup'); e.code = '23505'; throw e; });
    const res = await request(app()).post('/api/settings/branches').send({ name: 'A Main' });
    expect(res.status).toBe(409);
  });
});

describe('role permissions are per studio', () => {
  test('GET /permissions reads the caller organization', async () => {
    mockRows.settings = [{ key: 'perm_trainer_finance', value: 'true', type: 'boolean' }];
    const res = await request(app()).get('/api/settings/permissions');
    expect(res.status).toBe(200);
    expect(res.body.permissions.perm_trainer_finance).toBe(true);
    // Defaults still fill the rest.
    expect(res.body.permissions.perm_trainer_pt_module).toBe(true);
    expect(find(/FROM organization_settings/i).params[0]).toBe(ORG_A);
  });

  test('PUT /permissions writes only the caller organization', async () => {
    // One studio deciding its receptionists may record payments must not decide
    // that for the other five.
    await request(app()).put('/api/settings/permissions').send({ perm_reception_finance: true });
    const q = find(/INSERT INTO organization_settings/i);
    expect(q.params[0]).toBe(ORG_A);
    expect(q.params[1]).toEqual(['perm_reception_finance']);
  });

  test('unknown permission keys are ignored rather than stored', async () => {
    await request(app()).put('/api/settings/permissions').send({ perm_made_up: true });
    expect(find(/INSERT INTO organization_settings/i)).toBeUndefined();
  });
});

describe('gym / biometric settings are per studio', () => {
  test('GET /gym is scoped and still returns defaults for unset keys', async () => {
    mockRows.settings = [{ key: 'geofence_radius', value: '250', type: 'number' }];
    const res = await request(app()).get('/api/settings/gym');
    expect(res.body.geofence_radius).toBe(250);
    expect(res.body.enable_gps).toBe(true); // default
    const q = find(/FROM organization_settings/i);
    expect(q.sql).toMatch(/key = ANY\(\$2::text\[\]\)/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('PUT /gym rejects keys outside the allow-list', async () => {
    await request(app()).put('/api/settings/gym').send({ geofence_radius: 300, gym_name: 'sneaky' });
    const q = find(/INSERT INTO organization_settings/i);
    expect(q.params[1]).toEqual(['geofence_radius']);
  });
});
