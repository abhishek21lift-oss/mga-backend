// One 500 is not an outage.
//
// The numbers in this file are the real ones. On 5 August the Command Center
// raised 24 CRITICAL "API requests degraded" alerts in ten hours, and all but a
// handful said "1 server errors in 6 requests". Every one of them cleared
// itself, because the next five-minute window happened not to contain the one
// request that was failing.
//
// Two things were true at once, and it is worth keeping them apart:
//
//   The endpoint really was broken. /api/pt-os/clients/birthdays threw
//   "column reference organization_id is ambiguous" 49 times that day. That is
//   fixed separately, in pt-os.routes.js.
//
//   The alert rule was also wrong. MIN_SAMPLES_TO_GRADE guarded latency and
//   not the error rate, so at a quiet hour — six requests in the window — a
//   single failure read as 16.7% and tripped a 10% critical threshold. It
//   would have done that for any one broken endpoint, and it will again the
//   next time one breaks, which is why the rule is worth fixing on its own.
//
// The line this file draws: a floor on the error COUNT, not on the sample
// size. A sample gate would have silenced the one alert you cannot afford to
// miss — six requests in the window, all six failing, which is a dead API at
// three in the morning.
'use strict';

const { STATUS } = require('../modules/command-center/registry');
const metrics = require('../modules/command-center/httpMetrics');
const http = require('../modules/command-center/collectors/http.collector');

/** n requests, of which `errors` are 500s, all fast enough not to trip latency. */
function traffic(total, errors, ms = 20) {
  metrics.reset();
  for (let i = 0; i < errors; i++) metrics.record('GET', '/api/broken', 500, ms);
  for (let i = 0; i < total - errors; i++) metrics.record('GET', '/api/ok', 200, ms);
}

beforeEach(() => metrics.reset());

describe('the alerts that were firing all day', () => {
  test('1 server error in 6 requests is not CRITICAL', async () => {
    // 16.7% — over the 10% line on rate alone, and the single most common
    // alert in production that day.
    traffic(6, 1);
    const card = await http.collect();
    expect(card.status).not.toBe(STATUS.CRITICAL);
  });

  test('1 server error in 6 requests is not even amber', async () => {
    // One failed request in five minutes is a fact, not a degradation.
    traffic(6, 1);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.HEALTHY);
  });

  test('but the error is still reported, not hidden', async () => {
    // Not alerting on it must not turn into not showing it.
    traffic(6, 1);
    const card = await http.collect();
    expect(card.data.note).toMatch(/1 server error\(s\) in 6 requests/);
    expect(card.data.status.server_errors).toBe(1);
  });

  test('2 in 7 is amber, not red', async () => {
    // Also seen in production. Worth a look; not worth waking anybody.
    traffic(7, 2);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.WARNING);
  });

  test('3 in 8 is amber, not red', async () => {
    traffic(8, 3);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.WARNING);
  });
});

describe('the alerts that were real', () => {
  test('30 server errors in 30 requests is CRITICAL', async () => {
    // The backend booting against an unreachable database. Every request
    // failing is exactly what the card exists to show.
    traffic(30, 30);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toBe('30 server errors in 30 requests');
  });

  test('12 in 12 and 24 in 24 are CRITICAL', async () => {
    for (const n of [12, 24]) {
      traffic(n, n);
      const card = await http.collect();
      expect(card.status).toBe(STATUS.CRITICAL);
    }
  });

  // The case a sample-size gate would have broken, and the reason the floor is
  // on the error count instead.
  test('a total outage in a QUIET window is still CRITICAL', async () => {
    traffic(6, 6);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toBe('6 server errors in 6 requests');
  });

  test('a sustained error rate at real traffic is CRITICAL', async () => {
    traffic(100, 15);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
  });
});

describe('the floors themselves', () => {
  test('crossing the critical floor is what flips it', async () => {
    traffic(40, http.MIN_ERRORS_CRIT - 1);
    expect((await http.collect()).status).not.toBe(STATUS.CRITICAL);

    traffic(40, http.MIN_ERRORS_CRIT);
    expect((await http.collect()).status).toBe(STATUS.CRITICAL);
  });

  test('the rate still has to be crossed too — a floor is not a substitute', async () => {
    // 5 errors clears the count floor, but 5 in 500 is 1%: under both rate
    // thresholds. A busy API dropping the occasional request is not degraded.
    traffic(500, 5);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.HEALTHY);
  });

  test('no traffic is still healthy', async () => {
    const card = await http.collect();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.samples).toBe(0);
  });

  test('latency grading is untouched by any of this', async () => {
    metrics.reset();
    for (let i = 0; i < 30; i++) metrics.record('GET', '/api/slow', 200, http.P95_CRIT_MS + 500);
    const card = await http.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/p95/);
  });
});
