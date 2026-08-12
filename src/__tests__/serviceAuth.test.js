'use strict';
// X-Service-Auth — the AI service's attestation.
//
// The property under test is narrow and easy to get wrong in both directions:
//
//   * A browser sends no such header and must be completely unaffected. Making
//     this mandatory would 401 every existing client on deploy.
//   * A WRONG header must be refused rather than ignored. Ignoring it is the
//     failure that matters: rotate the secret on one side only and every AI
//     request keeps succeeding while silently losing its attestation, so
//     anything built on `req.serviceCaller` decays into fiction.
//
// And the header must never become a credential — a valid one grants nothing
// that the forwarded user token did not already grant. That is asserted last.

const express = require('express');
const request = require('supertest');

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { serviceAuth, safeEqual } = require('../middleware/serviceAuth');

const SECRET = 'a'.repeat(48);

function app() {
  const a = express();
  a.use(serviceAuth);
  a.get('/probe', (req, res) => res.json({ serviceCaller: req.serviceCaller ?? null }));
  return a;
}

let original;
beforeEach(() => { original = process.env.SERVICE_AUTH_SECRET; process.env.SERVICE_AUTH_SECRET = SECRET; });
afterEach(() => {
  if (original === undefined) delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = original;
});

describe('requests without the header', () => {
  test('pass through untouched — this is every browser', async () => {
    const res = await request(app()).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.serviceCaller).toBeNull();
  });

  test('pass even when the server has no secret configured', async () => {
    // A studio that never deploys the AI service must not be broken by this
    // middleware existing.
    delete process.env.SERVICE_AUTH_SECRET;
    const res = await request(app()).get('/probe');
    expect(res.status).toBe(200);
  });

  test('an empty header counts as absent, not as a wrong value', async () => {
    const res = await request(app()).get('/probe').set('X-Service-Auth', '');
    expect(res.status).toBe(200);
    expect(res.body.serviceCaller).toBeNull();
  });
});

describe('requests carrying the header', () => {
  test('a correct secret is tagged as the AI service', async () => {
    const res = await request(app()).get('/probe').set('X-Service-Auth', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.serviceCaller).toBe('ai');
  });

  test('a wrong secret is refused, not ignored', async () => {
    const res = await request(app()).get('/probe').set('X-Service-Auth', 'b'.repeat(48));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SERVICE_AUTH_INVALID');
  });

  test('a near-miss is still refused', async () => {
    const res = await request(app()).get('/probe').set('X-Service-Auth', `${SECRET}x`);
    expect(res.status).toBe(401);
  });

  test('an unverifiable claim fails closed when no secret is configured', async () => {
    // Half-configured deploy: the AI service has a secret, the ERP does not.
    // Answering "fine" to a claim you cannot check is worse than answering no.
    delete process.env.SERVICE_AUTH_SECRET;
    const res = await request(app()).get('/probe').set('X-Service-Auth', SECRET);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_AUTH_NOT_CONFIGURED');
  });

  test('the rejection never echoes what was presented', async () => {
    const attempt = 'guess-number-4171';
    const res = await request(app()).get('/probe').set('X-Service-Auth', attempt);
    expect(JSON.stringify(res.body)).not.toContain(attempt);
    // And not into the log either — a near-miss is the most useful thing an
    // attacker could get written to disk.
    const logger = require('../lib/logger');
    for (const call of logger.warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(attempt);
    }
  });
});

describe('the comparison itself', () => {
  test('matches only on equality', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  test('tolerates a length mismatch instead of throwing', () => {
    // crypto.timingSafeEqual throws on unequal lengths, and an early throw
    // would leak the secret's length through response timing. Both sides are
    // hashed first, so every comparison runs over 32 bytes.
    expect(() => safeEqual('short', 'a'.repeat(500))).not.toThrow();
    expect(safeEqual('short', 'a'.repeat(500))).toBe(false);
  });
});

describe('what the header does NOT do', () => {
  test('it is an attestation, never an authorisation input', () => {
    // The middleware's whole effect is one tag. It does not touch req.user,
    // req.organization_id, or anything tenantScope() reads — so a valid header
    // cannot widen what a request may see. If this test has to change, the
    // header has become a credential and the design has inverted.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'middleware', 'serviceAuth.js'), 'utf8');
    const body = src.slice(src.indexOf('function serviceAuth'));

    expect(body).toMatch(/req\.serviceCaller = 'ai'/);
    expect(body).not.toMatch(/req\.user\s*=/);
    expect(body).not.toMatch(/organization_id/);
    expect(body).not.toMatch(/req\.orgId\s*=/);
  });

  test('it is mounted before auth, so a forgery costs no database work', () => {
    const server = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const svc = server.indexOf("app.use('/api/', serviceAuth)");
    const origin = server.indexOf("app.use('/api/', originCheck)");

    expect(svc).toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(-1);
    expect(svc).toBeGreaterThan(origin);
    // And it is global rather than bolted onto one route, so a new endpoint
    // cannot accidentally accept an unverified attestation.
    expect(server).toMatch(/app\.use\('\/api\/', serviceAuth\)/);
  });
});
