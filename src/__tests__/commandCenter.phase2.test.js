// Command Center — Phase 2 collectors: http, ai, smtp, security.
//
// The theme across all four is that a metric must not overstate what it knows.
// Each of these had an easy wrong version:
//
//   http     grading a p95 drawn from four requests, or ranking endpoints by a
//            mean that hides the tail everyone complains about.
//   ai       reporting a "success rate" from a table that only records calls
//            that returned — 100% through a total outage.
//   smtp     opening a real SMTP handshake on every console tick.
//   security calling failed logins from one address an attack.
'use strict';

// The security collector reaches db/pool, which calls logger.fatal and
// process.exit(1) when DATABASE_URL is absent. There is no global jest setup
// file in this repo, so each suite supplies its own env — without this the
// suite passed or failed depending on what happened to be exported in the
// shell, which is not a test result.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const { STATUS } = require('../modules/command-center/registry');

// ── HTTP ring + collector ───────────────────────────────────────────────────
describe('http metrics ring', () => {
  const metrics = require('../modules/command-center/httpMetrics');

  beforeEach(() => metrics.reset());

  test('percentiles and error rate over the window', () => {
    for (let i = 1; i <= 100; i++) metrics.record('GET', '/api/x', 200, i);
    const s = metrics.summarise();

    expect(s.samples).toBe(100);
    expect(s.latency_ms.p50).toBe(50);
    expect(s.latency_ms.p95).toBe(95);
    expect(s.latency_ms.max).toBe(100);
    expect(s.status.error_rate).toBe(0);
  });

  test('the ring is bounded — old entries fall out, memory does not grow', () => {
    const n = metrics.CAPACITY + 500;
    for (let i = 0; i < n; i++) metrics.record('GET', '/api/x', 200, 5);
    const s = metrics.summarise();

    expect(s.samples).toBe(metrics.CAPACITY);
    // total_recorded keeps counting so the console can show throughput even
    // though only CAPACITY entries are retained.
    expect(s.total_recorded).toBe(n);
  });

  test('endpoints are ranked by p95, not by mean', () => {
    // Constructed so the two orderings actually disagree, which the first
    // draft of this test failed to do: it used 19 fast + 1 slow, and a single
    // outlier in twenty sits at p100, not p95 — so p95 correctly ignored it and
    // the test was wrong about the code rather than the other way round.
    //
    // Here `spiky` is 10% slow, which p95 does capture, while its MEAN stays
    // below `steady`'s:
    //   spiky  18×5ms + 2×2000ms -> mean 204.5ms, p95 2000ms
    //   steady 20×300ms          -> mean 300ms,   p95  300ms
    // Ranking by mean puts steady on top; ranking by p95 puts spiky on top, and
    // spiky is the one whose users are filing tickets.
    for (let i = 0; i < 18; i++) metrics.record('GET', '/api/spiky', 200, 5);
    for (let i = 0; i < 2; i++) metrics.record('GET', '/api/spiky', 200, 2000);
    for (let i = 0; i < 20; i++) metrics.record('GET', '/api/steady', 200, 300);

    const s = metrics.summarise();
    const spiky = s.slowest_endpoints.find((e) => e.endpoint === 'GET /api/spiky');
    const steady = s.slowest_endpoints.find((e) => e.endpoint === 'GET /api/steady');

    expect(s.slowest_endpoints[0].endpoint).toBe('GET /api/spiky');
    expect(spiky.p95_ms).toBe(2000);
    expect(steady.p95_ms).toBe(300);
    // The property under test: spiky wins on p95 despite a lower mean.
    const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    expect(mean([...Array(18).fill(5), 2000, 2000])).toBeLessThan(mean(Array(20).fill(300)));
  });

  test('one-hit endpoints are excluded from the slow ranking', () => {
    // A single cold-start request must not top the board all day.
    metrics.record('GET', '/api/rare', 200, 9000);
    for (let i = 0; i < 10; i++) metrics.record('GET', '/api/common', 200, 100);

    const s = metrics.summarise({ minSamples: 3 });
    expect(s.slowest_endpoints.map((e) => e.endpoint)).not.toContain('GET /api/rare');
  });

  test('4xx counts as an error, 5xx also counts as a server error', () => {
    metrics.record('GET', '/api/a', 404, 10);
    metrics.record('GET', '/api/a', 500, 10);
    metrics.record('GET', '/api/a', 200, 10);

    const s = metrics.summarise();
    expect(s.status.errors).toBe(2);
    expect(s.status.server_errors).toBe(1);
  });
});

describe('http collector', () => {
  const metrics = require('../modules/command-center/httpMetrics');
  const http = require('../modules/command-center/collectors/http.collector');

  beforeEach(() => metrics.reset());

  test('no traffic is healthy, not amber', async () => {
    const card = await http.collect();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.samples).toBe(0);
  });

  test('a slow p95 with enough samples turns the card amber and names the endpoint', async () => {
    for (let i = 0; i < 30; i++) metrics.record('GET', '/api/slow', 200, http.P95_WARN_MS + 200);
    const card = await http.collect();

    expect(card.status).toBe(STATUS.WARNING);
    expect(card.reason).toMatch(/\/api\/slow/);
  });

  test('a slow p95 from too few samples is NOT graded', async () => {
    // Four requests cannot support a p95. Grading them would cry wolf on every
    // restart, and an operator who learns to ignore the card has lost it.
    for (let i = 0; i < 4; i++) metrics.record('GET', '/api/slow', 200, 9000);
    const card = await http.collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.note).toMatch(/not graded/i);
  });

  test('server errors are graded even when the sample is thin', async () => {
    // A 500 is a request that did not happen. That does not need a percentile.
    for (let i = 0; i < 5; i++) metrics.record('GET', '/api/x', 500, 20);
    const card = await http.collect();

    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/server error/i);
  });
});

// ── SMTP ────────────────────────────────────────────────────────────────────
describe('smtp collector', () => {
  const load = () => require('../modules/command-center/collectors/smtp.collector');
  beforeEach(() => jest.resetModules());

  function withEmail(mock, rows = { total: 0, sent: 0, errored: 0, attempted_never_sent: 0, last_sent_at: null, last_error: null }) {
    jest.doMock('../lib/email', () => mock);
    jest.doMock('../db/pool', () => ({ query: async () => ({ rows: [rows] }) }));
    jest.doMock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  }

  test('unconfigured SMTP is CRITICAL, not unavailable', async () => {
    // Mail off means invitations and password resets vanish, and the
    // forgot-password endpoint says "sent" either way — nothing else reports it.
    withEmail({
      isConfigured: () => false,
      describeConfig: () => ({ missing: ['SMTP_HOST', 'SMTP_PASS'] }),
    });
    const card = await load().collect();

    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/SMTP_HOST/);
    expect(card.reason).toMatch(/silently discarded/i);
  });

  test('configured but nothing ever delivered is CRITICAL and quotes the error', async () => {
    // This is the platform's actual state: 2 invitations, 0 sent.
    withEmail(
      { isConfigured: () => true, describeConfig: () => ({ host: 'smtp.x', port: 587, from: 'a@b.c', missing: [] }) },
      { total: 2, sent: 0, errored: 1, attempted_never_sent: 1, last_sent_at: null, last_error: 'Connection timeout' },
    );
    const card = await load().collect();

    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/none delivered/i);
    expect(card.reason).toMatch(/Connection timeout/);
  });

  test('the default probe does NOT open an SMTP connection', async () => {
    // A handshake per console tick would hammer the provider and block on a
    // timeout. verifyConnection runs only on demand.
    const verify = jest.fn();
    withEmail(
      { isConfigured: () => true, describeConfig: () => ({ host: 'smtp.x', port: 587, from: 'a@b.c', missing: [] }), verifyConnection: verify },
      { total: 1, sent: 1, errored: 0, attempted_never_sent: 0, last_sent_at: new Date().toISOString(), last_error: null },
    );
    const card = await load().collect();

    expect(verify).not.toHaveBeenCalled();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.probe_note).toMatch(/on demand/i);
  });

  test('an explicit probe runs the handshake and a failure is critical', async () => {
    const verify = jest.fn(async () => ({ ok: false, reason: 'ETIMEDOUT', diagnosis: 'Port 587 blocked' }));
    withEmail(
      { isConfigured: () => true, describeConfig: () => ({ host: 'smtp.x', port: 587, from: 'a@b.c', missing: [] }), verifyConnection: verify },
      { total: 1, sent: 1, errored: 0, attempted_never_sent: 0, last_sent_at: null, last_error: null },
    );
    const card = await load().collect({ probe: true });

    expect(verify).toHaveBeenCalled();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/Port 587 blocked/);
  });
});

// ── Security ────────────────────────────────────────────────────────────────
describe('security collector posture', () => {
  const { posture } = require('../modules/command-center/collectors/security.collector');
  const ENV = process.env;

  afterEach(() => { process.env = ENV; });

  function withEnv(over) {
    process.env = { ...ENV, ...over };
    return posture();
  }

  test('a short JWT secret fails its check', () => {
    const p = withEnv({ JWT_SECRET: 'short' });
    expect(p.checks.find((c) => c.key === 'jwt_secret_length').ok).toBe(false);
  });

  test('a wildcard CORS origin fails', () => {
    const p = withEnv({ CORS_ORIGIN: '*' });
    expect(p.checks.find((c) => c.key === 'cors_not_wildcard').ok).toBe(false);
  });

  test('http origins fail in production but not in development', () => {
    const prod = withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'http://myptstudio.com' });
    expect(prod.checks.find((c) => c.key === 'cors_https_in_production').ok).toBe(false);

    const dev = withEnv({ NODE_ENV: 'development', CORS_ORIGIN: 'http://localhost:3000' });
    expect(dev.checks.find((c) => c.key === 'cors_https_in_production').ok).toBe(true);
  });

  test('missing WebAuthn config is caught', () => {
    // Exactly the failure that made passkeys unusable: without these two the
    // ceremony dies at verify and nothing server-side records why.
    const p = withEnv({ RP_ID: '', WEBAUTHN_ORIGIN: '' });
    const c = p.checks.find((x) => x.key === 'webauthn_rp_configured');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/passkeys cannot complete/i);
  });

  test('a fully configured environment scores 100', () => {
    const p = withEnv({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(48),
      FRONTEND_URL: 'https://myptstudio.com',
      CORS_ORIGIN: 'https://myptstudio.com,https://www.myptstudio.com',
      RP_ID: 'myptstudio.com',
      WEBAUTHN_ORIGIN: 'https://myptstudio.com',
      SENTRY_DSN: 'https://x@sentry.io/1',
    });
    expect(p.score).toBe(100);
    expect(p.failed_count).toBe(0);
  });
});
