// POST /api/auth/forgot-password — what it logs, and what it refuses to say.
//
// The route must answer identically whether or not an address is registered:
// a different response for a known address turns this endpoint into a user
// enumeration oracle. That constraint is why every failure here is invisible
// to the caller BY DESIGN, and why the server-side log is the only place the
// truth can live.
//
// One of the outcomes used to produce no log line at all. A request for an
// address with no user account did nothing and said nothing — identical, from
// the outside AND in the logs, to SMTP being down. "Password reset emails are
// not arriving" was therefore undiagnosable without reading this file: the
// operator could not tell an unregistered address from a broken mailer.
'use strict';

const store = [{ id: 'usr-1', email: 'admin@myptstudio.com' }];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    if (/from\s+users/i.test(sql) && /lower\(/i.test(sql)) {
      // Mirrors the route's btrim(LOWER(...)) on both sides.
      const q = String((params && params[0]) || '').trim().toLowerCase();
      const row = store.find((u) => u.email.trim().toLowerCase() === q) || null;
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  }),
}));

const mockSendPasswordReset = jest.fn();
jest.mock('../lib/email', () => ({
  sendPasswordReset: (...a) => mockSendPasswordReset(...a),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() };
jest.mock('../lib/logger', () => mockLog);

// otplib pulls in @scure/base, which ships ESM that Jest will not parse — the
// same incompatibility the Dockerfile pins a Node version for. Mocked so requiring
// the auth router does not drag it in; MFA is not what this file tests.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../routes/auth'));
  return a;
}

/** The logged outcome for a request, whichever level it was recorded at. */
function loggedOutcome() {
  const calls = [...mockLog.info.mock.calls, ...mockLog.warn.mock.calls, ...mockLog.error.mock.calls];
  const hit = calls.find((c) => c[0] && c[0].outcome);
  return hit ? hit[0].outcome : null;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockSendPasswordReset.mockResolvedValue({ sent: true });
});

describe('forgot-password', () => {
  test('an unknown address is logged as such rather than passing in silence', async () => {
    const res = await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(mockSendPasswordReset).not.toHaveBeenCalled();
    expect(loggedOutcome()).toBe('unknown_address');
  });

  test('the response is byte-identical for a known and an unknown address', async () => {
    // The whole reason the logs have to carry the detail: this must not leak.
    const known = await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'admin@myptstudio.com' });
    const unknown = await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  test('SMTP not being configured is reported as that, not as a send failure', async () => {
    mockSendPasswordReset.mockResolvedValue({ sent: false, reason: 'SMTP_NOT_CONFIGURED' });

    await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'admin@myptstudio.com' });
    await flush();

    expect(loggedOutcome()).toBe('smtp_not_configured');
  });

  test('a send failure is logged with the underlying reason', async () => {
    mockSendPasswordReset.mockRejectedValue(new Error('EAUTH'));

    await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'admin@myptstudio.com' });
    await flush();

    expect(loggedOutcome()).toBe('send_failed');
    const call = mockLog.error.mock.calls.find((c) => c[0] && c[0].outcome === 'send_failed');
    expect(call[0].err).toBe('EAUTH');
  });

  test('a successful send is logged too, so silence always means something is wrong', async () => {
    await request(app()).post('/api/auth/forgot-password')
      .send({ email: 'admin@myptstudio.com' });
    await flush();

    expect(loggedOutcome()).toBe('sent');
  });

  test('a stored address with stray whitespace still matches', async () => {
    // Easy to introduce by pasting into an admin field, and it previously made
    // the account permanently unable to reset — silently.
    store.push({ id: 'usr-2', email: '  spaced@myptstudio.com ' });
    try {
      await request(app()).post('/api/auth/forgot-password')
        .send({ email: 'spaced@myptstudio.com' });
      await flush();
      expect(mockSendPasswordReset).toHaveBeenCalled();
      expect(loggedOutcome()).toBe('sent');
    } finally {
      store.pop();
    }
  });
});
