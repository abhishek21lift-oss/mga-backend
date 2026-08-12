// Login event recording.
//
// The whole point of this module is that it CANNOT break a login. Most of what
// follows is that one property, checked from several directions, because the
// failure mode is invisible: a login that starts 500ing because an audit write
// threw would look like an outage with no obvious cause.
'use strict';

jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: mockQuery }));

const loginEvents = require('../lib/loginEvents');
const logger = require('../lib/logger');

const req = (over = {}) => ({
  ip: '203.0.113.9',
  get: (h) => (h.toLowerCase() === 'user-agent' ? 'Mozilla/5.0 (iPhone)' : undefined),
  ...over,
});

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); logger.warn.mockReset(); });

describe('it cannot break a login', () => {
  it('returns synchronously without awaiting the write', () => {
    // The auth routes do not await this. If it ever returned a promise they
    // had to settle, a slow database would slow every sign-in on the platform.
    let resolve;
    mockQuery.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    expect(loginEvents.record(req(), { outcome: 'success' })).toBeUndefined();
    resolve({ rows: [] });
  });

  it('swallows a rejected write', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "login_events" does not exist'));
    expect(() => loginEvents.record(req(), { outcome: 'success' })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('survives a request object with nothing on it', () => {
    // Some call sites are reached from paths where req is not fully formed.
    expect(() => loginEvents.record({}, { outcome: 'success' })).not.toThrow();
    expect(() => loginEvents.record(undefined, { outcome: 'success' })).not.toThrow();
  });
});

describe('what it records', () => {
  it('lower-cases the attempted email so grouping by target works', () => {
    // An attacker varying capitalisation would otherwise appear as separate
    // targets and slip under the brute-force threshold.
    loginEvents.record(req(), { outcome: 'bad_password', email: '  Priya@Iron.IN ' });
    expect(mockQuery.mock.calls[0][1][1]).toBe('priya@iron.in');
  });

  it('records the attempted address even when no account matched', () => {
    // That is precisely the credential-stuffing signal.
    loginEvents.record(req(), { outcome: 'unknown_user', email: 'nobody@x.in' });
    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBeNull();          // user_id
    expect(params[1]).toBe('nobody@x.in'); // email_attempted
  });

  it('takes the IP from req.ip, not from a client-supplied header', () => {
    // req.ip honours the app's trust-proxy setting; reading X-Forwarded-For
    // directly would record an attacker-chosen address as fact.
    loginEvents.record(req({ headers: { 'x-forwarded-for': '1.2.3.4' } }), { outcome: 'success' });
    expect(mockQuery.mock.calls[0][1][5]).toBe('203.0.113.9');
  });

  it('falls back to the socket address when req.ip is absent', () => {
    loginEvents.record({ ip: undefined, socket: { remoteAddress: '10.0.0.1' }, get: () => undefined },
      { outcome: 'success' });
    expect(mockQuery.mock.calls[0][1][5]).toBe('10.0.0.1');
  });

  it('caps an absurd email and user agent rather than storing them whole', () => {
    loginEvents.record(
      req({ get: () => 'U'.repeat(5000) }),
      { outcome: 'bad_password', email: `${'e'.repeat(1000)}@x.in` },
    );
    const params = mockQuery.mock.calls[0][1];
    expect(params[1].length).toBeLessThanOrEqual(320);
    expect(params[6].length).toBeLessThanOrEqual(500);
  });

  it('defaults the method to password', () => {
    loginEvents.record(req(), { outcome: 'success' });
    expect(mockQuery.mock.calls[0][1][4]).toBe('password');
  });

  it('carries the method through for the other sign-in paths', () => {
    for (const method of ['google', 'passkey']) {
      // mockClear, not mockReset — the latter would drop the resolved-value
      // implementation set in beforeEach, leaving query() returning undefined.
      mockQuery.mockClear();
      loginEvents.record(req(), { outcome: 'success', method });
      expect(mockQuery.mock.calls[0][1][4]).toBe(method);
    }
  });

  it('never writes anything credential-shaped', () => {
    // There is no column for a password, and the INSERT names its columns
    // explicitly — so no future caller can smuggle one in through the payload.
    loginEvents.record(req(), { outcome: 'bad_password', email: 'p@x.in', password: 'hunter2' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/password/i);
    expect(JSON.stringify(params)).not.toMatch(/hunter2/);
  });
});
