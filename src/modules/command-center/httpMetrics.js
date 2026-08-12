// src/modules/command-center/httpMetrics.js
//
// A bounded in-memory record of recent API requests.
//
// ── Why in memory ───────────────────────────────────────────────────────────
//
// The alternative is a row per request, and this app serves every studio from
// one small VPS with Postgres already carrying the product's own load. Writing
// a row for every request to measure how fast requests are is a tax on the
// thing being measured. A ring buffer costs one array slot per request and
// nothing at all on read.
//
// The trade is honest and bounded: this is the CURRENT PROCESS since its last
// restart. It is not history, and after a deploy it is empty. Percentiles come
// with the sample count so the client can render "p95 420ms (n=12)" rather than
// implying a fortnight of data.
//
// ── Why it hooks the existing logger, not a new middleware ──────────────────
//
// server.js already times every /api/* request in its `res.on('finish')`
// handler. A second middleware doing the same thing would double the work and,
// worse, could disagree with the logs when someone changes one and not the
// other. record() is called from that same handler.
'use strict';

// 2000 requests is roughly a busy hour here and costs well under a megabyte.
const CAPACITY = Number(process.env.CC_HTTP_RING_SIZE) || 2000;

const ring = new Array(CAPACITY);
let writeIndex = 0;
let total = 0;

/**
 * Record one finished request. Must stay allocation-light and never throw —
 * it runs on the response path of every API call.
 *
 * @param {string} method
 * @param {string} route  the matched ROUTE, not the raw url: /api/clients/:id,
 *   never /api/clients/8f3e…. Raw urls would make every id its own endpoint,
 *   so "slowest endpoints" would list a thousand one-hit entries, and ids would
 *   sit in memory for no reason.
 * @param {number} status
 * @param {number} ms
 */
function record(method, route, status, ms) {
  ring[writeIndex] = { at: Date.now(), method, route, status, ms };
  writeIndex = (writeIndex + 1) % CAPACITY;
  total += 1;
}

/** Entries newer than windowMs, oldest first. */
function entries(windowMs) {
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  const out = [];
  for (let i = 0; i < CAPACITY; i++) {
    const e = ring[(writeIndex + i) % CAPACITY];
    if (e && e.at >= cutoff) out.push(e);
  }
  return out;
}

/** Nearest-rank percentile over a pre-sorted numeric array. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * Aggregate the window.
 *
 * Endpoints are ranked by p95 rather than by mean: an endpoint that is fast
 * 95% of the time and terrible the rest is exactly the one users complain
 * about and the one a mean hides. Endpoints with fewer than `minSamples` hits
 * are excluded from the ranking, because a single 3-second cold-start request
 * should not top the "slowest endpoints" board all day.
 */
function summarise({ windowMs = 5 * 60 * 1000, minSamples = 3, topN = 5 } = {}) {
  const rows = entries(windowMs);
  if (!rows.length) {
    return {
      window_ms: windowMs, samples: 0, ring_capacity: CAPACITY,
      total_recorded: total, latency_ms: null, status: null,
      slowest_endpoints: [], busiest_endpoints: [],
      note: 'No requests recorded in this window (the ring is per-process and empties on restart)',
    };
  }

  const all = rows.map((r) => r.ms).sort((a, b) => a - b);
  const byEndpoint = new Map();
  let errors = 0; let serverErrors = 0;

  for (const r of rows) {
    if (r.status >= 400) errors += 1;
    if (r.status >= 500) serverErrors += 1;
    const key = `${r.method} ${r.route}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(r);
  }

  const endpoints = [...byEndpoint.entries()].map(([key, list]) => {
    const times = list.map((r) => r.ms).sort((a, b) => a - b);
    return {
      endpoint: key,
      count: list.length,
      p50_ms: percentile(times, 50),
      p95_ms: percentile(times, 95),
      max_ms: times[times.length - 1],
      errors: list.filter((r) => r.status >= 400).length,
    };
  });

  return {
    window_ms: windowMs,
    samples: rows.length,
    ring_capacity: CAPACITY,
    total_recorded: total,
    latency_ms: {
      p50: percentile(all, 50),
      p95: percentile(all, 95),
      p99: percentile(all, 99),
      max: all[all.length - 1],
      mean: Math.round(all.reduce((a, b) => a + b, 0) / all.length),
    },
    status: {
      total: rows.length,
      errors,
      server_errors: serverErrors,
      error_rate: Math.round((errors / rows.length) * 1000) / 1000,
    },
    slowest_endpoints: endpoints
      .filter((e) => e.count >= minSamples)
      .sort((a, b) => b.p95_ms - a.p95_ms)
      .slice(0, topN),
    busiest_endpoints: [...endpoints].sort((a, b) => b.count - a.count).slice(0, topN),
  };
}

/** Tests only. */
function reset() {
  ring.fill(undefined);
  writeIndex = 0;
  total = 0;
}

module.exports = { record, summarise, entries, percentile, reset, CAPACITY };
