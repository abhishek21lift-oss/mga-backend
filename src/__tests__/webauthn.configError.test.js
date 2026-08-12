// WebAuthn must not silently serve an rpId it knows is wrong.
//
// The failure this prevents: with RP_ID unset and no usable Origin or
// x-forwarded-host, getEffectiveRpId() fell back to 'localhost'. In production
// that is handed to a browser sitting on a real domain, and
// navigator.credentials.create() throws SecurityError — "the relying party ID
// is not a registrable domain suffix of, nor equal to, the current domain".
//
// That failure is entirely client-side. /options has already returned 200 and
// written its challenge row, /verify is never called, and the server logs
// nothing. All that is left is an orphaned challenge, which looks exactly like
// a user who opened the dialog and changed their mind. The live database shows
// the signature: 6 challenges, 0 credentials, 0 login_events with a passkey
// method, and not one webauthn row in activity_log.
//
// RP_ID and WEBAUTHN_ORIGIN are set per-deployment — deliberately not in
// the repo — so a fresh deployment has neither until someone sets them by hand.
// Making that a named 503 is the difference between "passkeys don't work" and
// "RP_ID is not set on this deployment".
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@b.c', name: 'A', organization_id: 'org1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

const ENV = process.env;

/** Fresh module per test — rpId resolution reads env at require time (isProd). */
function app({ prod, rpId, origin }) {
  jest.resetModules();
  process.env = { ...ENV };
  process.env.NODE_ENV = prod ? 'production' : 'test';
  if (rpId) process.env.RP_ID = rpId; else delete process.env.RP_ID;
  if (origin) process.env.WEBAUTHN_ORIGIN = origin; else delete process.env.WEBAUTHN_ORIGIN;

  const a = express();
  a.use(express.json());
  a.use('/api/auth/webauthn', require('../routes/auth-webauthn'));
  // Generic handler, to prove the 503 is produced by the route and does not
  // merely fall through to whatever the app's error middleware would render.
  a.use((err, _req, res, _next) => res.status(500).json({ error: 'generic handler' }));
  return a;
}

afterEach(() => { process.env = ENV; });

describe('WebAuthn rpId misconfiguration', () => {
  test('production with no RP_ID and no usable headers fails loudly, not silently', async () => {
    const res = await request(app({ prod: true })).post('/api/auth/webauthn/register/options');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WEBAUTHN_NOT_CONFIGURED');
    // The message has to name the variable — its whole job is to be actionable.
    expect(res.body.error).toMatch(/RP_ID/);
    expect(res.body.error).toMatch(/WEBAUTHN_ORIGIN/);
    // Not the generic handler: an opaque 500 is the thing being replaced.
    expect(res.body.error).not.toMatch(/generic handler/);
  });

  test('login/options fails the same way — it is unauthenticated and hit first', async () => {
    const res = await request(app({ prod: true }))
      .post('/api/auth/webauthn/login/options')
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });

  test('no challenge row is written when the config is broken', async () => {
    // A challenge saved for a ceremony that cannot possibly complete is the
    // orphan row that made the original failure so hard to read.
    const pool = require('../db/pool');
    pool.query.mockClear();
    await request(app({ prod: true })).post('/api/auth/webauthn/register/options');

    const inserts = pool.query.mock.calls
      .filter(([sql]) => /INSERT INTO webauthn_challenges/i.test(String(sql)));
    expect(inserts).toHaveLength(0);
  });

  test('RP_ID set in production is honoured and the ceremony proceeds', async () => {
    const res = await request(app({ prod: true, rpId: 'studio.example.com', origin: 'https://studio.example.com' }))
      .post('/api/auth/webauthn/register/options');

    expect(res.status).toBe(200);
    expect(res.body.rp.id).toBe('studio.example.com');
    expect(typeof res.body.challenge).toBe('string');
  });

  test('a proxied request derives rpId from x-forwarded-host without RP_ID', async () => {
    // The Vercel rewrite path: the browser talks to the Vercel domain, Vercel
    // proxies server-side and may drop Origin but always sets this header.
    const res = await request(app({ prod: true }))
      .post('/api/auth/webauthn/register/options')
      .set('x-forwarded-host', 'app.example.com');

    expect(res.status).toBe(200);
    expect(res.body.rp.id).toBe('app.example.com');
  });

  test('development still falls back to localhost rather than refusing to run', async () => {
    // Local dev has no RP_ID and no proxy headers, and must keep working.
    const res = await request(app({ prod: false })).post('/api/auth/webauthn/register/options');

    expect(res.status).toBe(200);
    expect(res.body.rp.id).toBe('localhost');
  });
});
