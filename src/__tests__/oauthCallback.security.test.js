'use strict';

/**
 * Google Calendar OAuth callback — tenant safety and state handling.
 *
 * This endpoint is unauthenticated by necessity: Google redirects the user's
 * browser to it, and the session cookie does not reliably survive that hop.
 * Identity therefore comes from the `state` parameter, which is a JWT this
 * server signed and which carries the user id.
 *
 * That makes state the entire trust boundary, so these tests exercise it as
 * one: unsigned, wrong-secret, wrong-purpose, expired, malformed, missing, and
 * a token minted for a different user. What must never happen is a callback
 * writing credentials for a user the caller did not prove they are.
 *
 * A known limitation is pinned here rather than papered over: state is signed
 * but not stored, so it is not single-use and can be replayed until it
 * expires. See docs/WEBHOOK-SECURITY.md — the test at the bottom documents the
 * behaviour so a future fix has something to change deliberately.
 */

const jwt = require('jsonwebtoken');

const SECRET = 'oauth-callback-test-secret-0000000000';

// `mock` prefix: jest.mock factories are hoisted and may only close over
// variables named this way.
const mockSaveTokens = jest.fn();
jest.mock('../lib/google-calendar', () => ({
  isConfigured: () => true,
  generateAuthUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  saveTokensFromCode: (...a) => mockSaveTokens(...a),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'usr-a', organization_id: 'org-a' }; next(); },
}));

const express = require('express');
const request = require('supertest');

function makeApp() {
  process.env.JWT_SECRET = SECRET;
  process.env.FRONTEND_URL = 'http://localhost:3000';
  const app = express();
  app.use('/api/calendar', require('../routes/calendar'));
  return app;
}

const state = (payload, opts = {}) => jwt.sign(payload, opts.secret || SECRET, {
  expiresIn: opts.expiresIn || '10m',
});

/** The callback always redirects; the reason query tells us what it decided. */
const reasonOf = (res) => {
  const loc = res.headers.location || '';
  const m = loc.match(/[?&]reason=([^&]+)/);
  if (m) return m[1];
  if (/calendar=connected/.test(loc)) return 'connected';
  if (/calendar=denied/.test(loc)) return 'denied';
  return loc;
};

beforeEach(() => { mockSaveTokens.mockReset().mockResolvedValue(undefined); });

describe('Google Calendar callback — state is the trust boundary', () => {
  const cases = [
    ['missing state', {}, 'missing_params'],
    ['unsigned garbage', { state: 'not-a-jwt' }, 'invalid_state'],
    ['signed with the wrong secret',
      { state: state({ user_id: 'usr-evil', purpose: 'calendar_oauth' }, { secret: 'wrong-secret' }) },
      'invalid_state'],
    ['wrong purpose — a token minted for another flow',
      { state: state({ user_id: 'usr-a', purpose: 'password_reset' }) }, 'invalid_state'],
    ['expired', { state: state({ user_id: 'usr-a', purpose: 'calendar_oauth' }, { expiresIn: '-1s' }) },
      'invalid_state'],
    ['tampered payload', { state: `${state({ user_id: 'usr-a', purpose: 'calendar_oauth' })}x` },
      'invalid_state'],
  ];

  for (const [name, extra, expected] of cases) {
    it(`rejects ${name} without storing credentials`, async () => {
      const app = makeApp();
      const res = await request(app).get('/api/calendar/callback').query({ code: 'auth-code', ...extra });
      expect(reasonOf(res)).toBe(expected);
      // The assertion that matters: no token exchange, so nothing is written
      // for anybody. A redirect alone would not prove that.
      expect(mockSaveTokens).not.toHaveBeenCalled();
    });
  }

  it('requires an authorization code as well as a state', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/calendar/callback')
      .query({ state: state({ user_id: 'usr-a', purpose: 'calendar_oauth' }) });
    expect(reasonOf(res)).toBe('missing_params');
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it('binds the write to the user id inside the signed state, never to the query', async () => {
    const app = makeApp();
    // A caller supplying its own user_id/organization_id alongside a state for
    // somebody else must not redirect the write. Only the signed value counts.
    await request(app).get('/api/calendar/callback').query({
      code: 'auth-code',
      state: state({ user_id: 'usr-victim', purpose: 'calendar_oauth' }),
      user_id: 'usr-attacker',
      organization_id: 'org-b',
    });
    expect(mockSaveTokens).toHaveBeenCalledTimes(1);
    expect(mockSaveTokens).toHaveBeenCalledWith('usr-victim', 'auth-code');
  });

  it('cannot be pointed at another tenant, because no tenant id crosses the wire', async () => {
    const src = require('node:fs').readFileSync(require.resolve('../routes/calendar'), 'utf8');
    // Tenant identity is not a parameter of this endpoint at all: the write is
    // keyed on the user id in the signed state, and the row it writes is keyed
    // on user_id. There is nothing here for a caller to forge.
    expect(src).not.toMatch(/req\.query\.organization_id|req\.query\.org_id/);
    expect(src).not.toMatch(/req\.body\.organization_id|req\.body\.org_id/);
    expect(src).toMatch(/jwt\.verify\(state/);
    expect(src).toMatch(/purpose !== 'calendar_oauth'/);
  });

  it('fails closed when the token exchange or the database refuses', async () => {
    const app = makeApp();
    // google_calendar_tokens carries no organization_id, so migration 157 gave
    // it no tenant_isolation policy and app_tenant hits the deny-all: the
    // INSERT raises 42501. The callback must surface that as an error, not as
    // a connected integration.
    mockSaveTokens.mockRejectedValueOnce(
      Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }),
    );
    const res = await request(app).get('/api/calendar/callback')
      .query({ code: 'auth-code', state: state({ user_id: 'usr-a', purpose: 'calendar_oauth' }) });
    expect(reasonOf(res)).toBe('token_exchange');
  });

  it('does not put the authorization code or the state into the redirect', async () => {
    const app = makeApp();
    const st = state({ user_id: 'usr-a', purpose: 'calendar_oauth' });
    const res = await request(app).get('/api/calendar/callback').query({ code: 'secret-auth-code', state: st });
    const loc = res.headers.location || '';
    // Both are bearer credentials for the duration of the flow; a redirect URL
    // reaches browser history, Referer headers and any proxy in between.
    expect(loc).not.toContain('secret-auth-code');
    expect(loc).not.toContain(st);
  });

  it('KNOWN LIMITATION: state is signed but not single-use, so it replays until it expires', async () => {
    const app = makeApp();
    const st = state({ user_id: 'usr-a', purpose: 'calendar_oauth' });
    const q = { code: 'auth-code', state: st };

    await request(app).get('/api/calendar/callback').query(q);
    await request(app).get('/api/calendar/callback').query(q);

    // Two exchanges from one state. Google's authorization codes are
    // single-use, which limits this in practice, but the application does not
    // rely on that and does not enforce it: nothing records that this state
    // was consumed. Documented in docs/WEBHOOK-SECURITY.md; the fix is a
    // durable single-use nonce, which this assertion will then contradict —
    // deliberately, so the change has to be made on purpose.
    expect(mockSaveTokens).toHaveBeenCalledTimes(2);
  });
});
