// WebAuthn origin checking must span www and apex, because rpId already does.
//
// The reported failure, from the passkeys screen on a real deployment:
//
//   [Step 3 - verify] Credential verification failed: Unexpected registration
//   response origin "https://www.myptstudio.com", expected
//   "https://myptstudio.com"
//
// WEBAUTHN_ORIGIN was the apex; the browser was on www. Reaching step 3 proves
// rpId was fine — an RP ID only has to be a registrable suffix of the page's
// domain, so `myptstudio.com` was accepted by the browser for a page on
// `www.myptstudio.com`. Origin comparison is exact, so only that half failed.
// The two checks disagreed about the same site.
//
// These tests pin the resolution (accept the www-toggled sibling) and, more
// importantly, its limit: one `www` label, never an arbitrary subdomain.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', email: 'a@b.c', name: 'A', organization_id: 'o1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const ENV = process.env;

/**
 * The verifier is where the mismatch actually bit, so these assert on what is
 * handed to it rather than on a route's status code — the route cannot reach
 * verification without a real authenticator response.
 */
function expectedOriginFor({ envOrigin, rpId, headers = {} }) {
  jest.resetModules();
  process.env = { ...ENV, NODE_ENV: 'production' };
  if (envOrigin) process.env.WEBAUTHN_ORIGIN = envOrigin; else delete process.env.WEBAUTHN_ORIGIN;

  // RP_ID has to be present whenever the request carries no proxy headers:
  // in production, an underivable rpId is a 503 by design (see
  // webauthn.configError.test.js) and the route would never reach the
  // verifier these tests inspect. rpId is not what is under test here.
  const effectiveRpId = rpId || (Object.keys(headers).length ? null : 'myptstudio.com');
  if (effectiveRpId) process.env.RP_ID = effectiveRpId; else delete process.env.RP_ID;

  let captured;
  jest.doMock('@simplewebauthn/server', () => ({
    generateRegistrationOptions: jest.fn(async () => ({ challenge: 'c', rp: {}, user: {} })),
    generateAuthenticationOptions: jest.fn(async () => ({ challenge: 'c' })),
    verifyRegistrationResponse: jest.fn(async (args) => {
      captured = args.expectedOrigin;
      return { verified: false };
    }),
    verifyAuthenticationResponse: jest.fn(async () => ({ verified: false })),
  }));

  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(express.json());
  app.use('/api/auth/webauthn', require('../routes/auth-webauthn'));

  const pool = require('../db/pool');
  pool.query.mockImplementation(async (sql) =>
    (/SELECT challenge FROM webauthn_challenges/i.test(String(sql))
      ? { rows: [{ challenge: 'c' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));

  let req = request(app).post('/api/auth/webauthn/register/verify');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({ registration: { id: 'x', response: {} } }).then(() => captured);
}

afterEach(() => { process.env = ENV; });

describe('WebAuthn expectedOrigin spans www and apex', () => {
  test('apex in WEBAUTHN_ORIGIN also accepts the www host — the reported bug', async () => {
    const origins = await expectedOriginFor({ envOrigin: 'https://myptstudio.com' });

    expect(origins).toContain('https://myptstudio.com');
    expect(origins).toContain('https://www.myptstudio.com');
  });

  test('www in WEBAUTHN_ORIGIN also accepts the apex — the mirror case', async () => {
    const origins = await expectedOriginFor({ envOrigin: 'https://www.myptstudio.com' });

    expect(origins).toContain('https://www.myptstudio.com');
    expect(origins).toContain('https://myptstudio.com');
  });

  test('only the www label is added — other subdomains stay rejected', async () => {
    // The whole point of doing this narrowly. If this ever contains an
    // arbitrary subdomain, the origin check has stopped being a check.
    const origins = await expectedOriginFor({ envOrigin: 'https://myptstudio.com' });

    expect(origins).not.toContain('https://evil.myptstudio.com');
    expect(origins).not.toContain('https://api.myptstudio.com');
    expect(origins).toHaveLength(2);
  });

  test('a comma-separated list keeps every entry and expands each', async () => {
    const origins = await expectedOriginFor({
      envOrigin: 'https://myptstudio.com, https://staging.myptstudio.com',
    });

    expect(origins).toEqual(expect.arrayContaining([
      'https://myptstudio.com',
      'https://www.myptstudio.com',
      'https://staging.myptstudio.com',
      'https://www.staging.myptstudio.com',
    ]));
  });

  test('the scheme and port of the configured origin are preserved', async () => {
    const origins = await expectedOriginFor({ envOrigin: 'http://myptstudio.com:8080' });

    expect(origins).toContain('http://myptstudio.com:8080');
    expect(origins).toContain('http://www.myptstudio.com:8080');
  });

  test('no trailing slash — WebAuthn origins are compared exactly', async () => {
    // URL#href would give "https://www.myptstudio.com/", which matches nothing.
    const origins = await expectedOriginFor({ envOrigin: 'https://myptstudio.com' });

    for (const o of origins) expect(o).not.toMatch(/\/$/);
  });

  test('the derived path expands too, so a proxied www request verifies', async () => {
    const origins = await expectedOriginFor({
      headers: { 'x-forwarded-host': 'www.myptstudio.com', 'x-forwarded-proto': 'https' },
    });

    expect(origins).toContain('https://www.myptstudio.com');
    expect(origins).toContain('https://myptstudio.com');
  });
});
