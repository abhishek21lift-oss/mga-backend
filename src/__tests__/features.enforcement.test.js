// Feature ENFORCEMENT — the guard, and the wiring that makes it run.
//
// features.resolution.test.js already covers decide()'s precedence rules. This
// covers the part that was missing entirely: requireFeature(), and the fact
// that server.js mounts it somewhere it can actually work.
//
// The wiring assertions matter more than they look. requireFeature reads
// req.user and returns next() when there isn't one, so a gate mounted BEFORE
// auth enforces nothing while appearing wired — a toggle in the Control Centre
// that silently does nothing. There is no runtime error to notice; only a test
// like this catches it.

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');
const { requireFeature } = require('../lib/features');

const ORG = '11111111-1111-1111-1111-111111111111';

/** One row shaped like RESOLVE_SQL's output. */
const row = (key, { enabled = true, core = false } = {}) => ({
  key, name: key, description: '', category: 'x',
  is_core: core, is_plan_gated: false, global_enabled: true,
  default_enabled: enabled, sort_order: 1,
  override_enabled: null, override_active: false, plan_enabled: null,
});

function appWith(user) {
  const a = express();
  a.use((req, _res, next) => { req.user = user; next(); });
  a.get('/thing', requireFeature('ai_suite'), (_q, s) => s.json({ ok: true }));
  return a;
}

beforeEach(() => pool.query.mockReset());

describe('requireFeature', () => {
  it('403s with FEATURE_DISABLED when the studio has it off', async () => {
    pool.query.mockResolvedValue({ rows: [row('ai_suite', { enabled: false })] });
    const res = await request(appWith({ organization_id: ORG, role: 'admin' })).get('/thing');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
    expect(res.body.error.feature).toBe('ai_suite');
  });

  it('lets the request through when the studio has it on', async () => {
    pool.query.mockResolvedValue({ rows: [row('ai_suite', { enabled: true })] });
    const res = await request(appWith({ organization_id: ORG, role: 'admin' })).get('/thing');
    expect(res.status).toBe(200);
  });

  it('never gates a platform operator', async () => {
    // A super admin is not inside a tenant, so tenant flags do not apply.
    pool.query.mockResolvedValue({ rows: [row('ai_suite', { enabled: false })] });
    const res = await request(appWith({ organization_id: ORG, role: 'super_admin' })).get('/thing');
    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails OPEN on an unknown key rather than locking a studio out', async () => {
    // A typo in a guard should not take a working feature away from every
    // studio. The registry is validated when a key is written, not read.
    pool.query.mockResolvedValue({ rows: [row('something_else')] });
    const res = await request(appWith({ organization_id: ORG, role: 'admin' })).get('/thing');
    expect(res.status).toBe(200);
  });

  it('does nothing without a user — which is why mount order matters', async () => {
    // Documents the footgun the wiring tests below exist to prevent.
    const res = await request(appWith(undefined)).get('/thing');
    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('server.js wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('puts auth BEFORE requireFeature in the gate helper', () => {
    // If these ever swap, every gate silently stops enforcing.
    const gate = server.match(/const gate = \(key\) => \[([^\]]+)\]/);
    expect(gate).not.toBeNull();
    const order = gate[1].replace(/\s/g, '');
    expect(order).toBe('auth,requireFeature(key)');
  });

  it('gates the capabilities the Control Centre advertises', () => {
    for (const key of [
      'ai_suite', 'ai_knowledge_base', 'attendance', 'programs',
      'insights', 'communication', 'integrations', 'packages', 'finance',
    ]) {
      expect(server).toMatch(new RegExp(`gate\\('${key}'\\)`));
    }
  });

  it('never gates auth, subscription or payments', () => {
    // A studio must always be able to sign in and pay us, whatever else an
    // operator has switched off. Gating these could lock a studio out of
    // fixing its own billing — the one thing that must never happen.
    const gatedMounts = [...server.matchAll(/app\.use\('([^']+)'[^\n]*gate\(/g)].map((m) => m[1]);
    for (const mount of gatedMounts) {
      expect(mount).not.toMatch(/^\/api\/(auth|subscription|payments)/);
    }
    expect(gatedMounts.length).toBeGreaterThan(0);
  });

  it('never gates a core feature', () => {
    // clients and sessions are is_core in the registry: decide() forces them
    // on, so a gate would be dead code implying a control that does not exist.
    expect(server).not.toMatch(/gate\('clients'\)/);
    expect(server).not.toMatch(/gate\('sessions'\)/);
  });
});
