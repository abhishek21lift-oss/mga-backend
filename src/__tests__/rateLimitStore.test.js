// Rate limits are shared across replicas, and degrade rather than fail.
//
// Audit finding H-4. Every limiter used express-rate-limit's default store —
// an in-process Map. Correct for exactly one api container, quietly wrong for
// two: each replica keeps its own counters, so "30 login attempts per 15
// minutes" becomes 30 x N for an attacker who gets round-robined. The control
// does not break loudly when the service scales out, it silently weakens.
//
// Redis was already a hard dependency (five BullMQ queues), so this is a second
// consumer of existing infrastructure, not new infrastructure.
//
// Two properties have to hold together, and they pull in opposite directions:
// the store must be SHARED when Redis is available, and the app must still work
// when it is not — redis.js is explicit that Redis is optional. So this file
// tests both the wiring and the degradation.

'use strict';

const fs = require('fs');
const path = require('path');

const mockRedisState = { configured: true };
jest.mock('../lib/redis', () => ({
  isConfigured: () => mockRedisState.configured,
  getConnection: () => ({
    // rate-limit-redis loads its Lua script on init and expects a SHA string
    // back; everything else in its protocol is numeric. Returning 1 for both
    // makes the store throw "unexpected reply from redis client" at construction.
    call: jest.fn(async (cmd) => (String(cmd).toUpperCase() === 'SCRIPT' ? 'a'.repeat(40) : 1)),
  }),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => mockLog);

const { makeStore } = require('../lib/rateLimitStore');

beforeEach(() => {
  mockRedisState.configured = true;
  Object.values(mockLog).forEach((f) => f.mockClear());
});

describe('makeStore', () => {
  it('returns a Redis-backed store when Redis is configured', () => {
    const store = makeStore('login');

    expect(store).toBeDefined();
    // rate-limit-redis stores expose the express-rate-limit Store interface.
    expect(typeof store.increment).toBe('function');
  });

  it('falls back to the in-memory store when Redis is not configured', () => {
    // undefined is meaningful here: express-rate-limit reads it as "no store
    // given" and uses its own default, which is exactly the previous
    // behaviour. Local dev and single-container deploys are unaffected.
    mockRedisState.configured = false;

    expect(makeStore('login')).toBeUndefined();
  });

  it('says so, once, when limits are only per-process', () => {
    // The "warned already" flag is module-level and deliberately survives for
    // the life of the process — eleven identical warnings at boot would be
    // noise. So this needs a fresh copy of the module to observe the first one.
    mockRedisState.configured = false;

    jest.isolateModules(() => {
      const fresh = require('../lib/rateLimitStore');
      fresh.makeStore('a');
      fresh.makeStore('b');
      fresh.makeStore('c');
    });

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0][0]).toMatch(/per-process/i);
  });

  it('refuses a missing prefix rather than letting limiters share a counter', () => {
    // Two limiters on one prefix share one budget: a burst of searches would
    // consume the login allowance. Failing loudly at boot beats debugging that.
    expect(() => makeStore()).toThrow(/unique string prefix/i);
    expect(() => makeStore('')).toThrow(/unique string prefix/i);
  });

  it('namespaces keys per limiter', () => {
    const a = makeStore('login');
    const b = makeStore('search');

    expect(a.prefix).toBe('rl:login:');
    expect(b.prefix).toBe('rl:search:');
    expect(a.prefix).not.toBe(b.prefix);
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// Source-level, because the risk is a limiter being ADDED later without a
// store — which no unit test of the existing ones would notice.

const FILES = [
  'src/server.js',
  'src/routes/auth-webauthn.js',
  'src/routes/client-activation.js',
  'src/routes/invitations.js',
  'src/routes/profile.js',
  'src/routes/qr-checkin.js',
  'src/routes/search.js',
];

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

describe('every limiter in the codebase uses the shared store', () => {
  it('finds the limiters, so this cannot pass vacuously', () => {
    const total = FILES.reduce((n, f) => n + (read(f).match(/rateLimit\(\{/g) || []).length, 0);
    expect(total).toBeGreaterThanOrEqual(11);
  });

  it.each(FILES)('%s wires store + passOnStoreError on each limiter', (file) => {
    const src = read(file);
    const limiters = (src.match(/rateLimit\(\{/g) || []).length;
    const stores = (src.match(/store: makeStore\('/g) || []).length;
    const passOn = (src.match(/passOnStoreError: true/g) || []).length;

    // A new limiter added without a store silently reintroduces the finding
    // for that endpoint only — the hardest kind to notice.
    expect(stores).toBe(limiters);
    expect(passOn).toBe(limiters);
  });

  it('gives every limiter a DISTINCT prefix', () => {
    const prefixes = FILES.flatMap((f) => [...read(f).matchAll(/makeStore\('([a-z]+)'\)/g)].map((m) => m[1]));

    expect(prefixes.length).toBeGreaterThanOrEqual(11);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('pairs the store with passOnStoreError so a Redis blip degrades, not 500s', () => {
    // Without passOnStoreError, a store error propagates and express-rate-limit
    // answers 500 — turning a Redis hiccup into a full API outage, which is
    // strictly worse than the per-process counters this replaces.
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/rateLimit\(\{([\s\S]{0,200}?)\}\)/g)) {
        if (/store: makeStore/.test(m[1])) {
          expect(m[1]).toMatch(/passOnStoreError: true/);
        }
      }
    }
  });
});
