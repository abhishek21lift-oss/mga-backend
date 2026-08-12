// src/modules/command-center/registry.js
//
// The collector contract, the timeout/severity harness, and the registry every
// other part of the Command Center reads.
//
// Why a registry rather than a service that calls nine things by hand: the
// Command Center has to answer "what is the state of everything" on a timer,
// over a WebSocket, per-card. That means every source needs the same shape
// (so the UI can render an unknown card), the same failure mode (so one dead
// dependency degrades one card), and its own cache TTL (so a 400ms Docker call
// is not made every second just because memory is sampled every second).
//
// The failure mode is the important part and it is copied deliberately from
// lib/queueHealth.js, which already got this right: a probe against something
// unreachable must resolve to an unhealthy VALUE, never reject. A health
// endpoint that 500s because one check timed out is a health endpoint that
// tells you nothing at the exact moment you need it.
'use strict';

const logger = require('../../lib/logger');

/** Card states, worst last — ordering matters for rollups. */
const STATUS = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  /** The probe could not run at all: no socket mounted, no key configured. */
  UNAVAILABLE: 'unavailable',
  /** The probe ran and did not answer in time. */
  TIMEOUT: 'timeout',
};

const SEVERITY_ORDER = [
  STATUS.HEALTHY,
  STATUS.UNAVAILABLE,
  STATUS.WARNING,
  STATUS.TIMEOUT,
  STATUS.CRITICAL,
];

/**
 * Roll many card statuses into one.
 *
 * UNAVAILABLE deliberately ranks BELOW warning: a Docker socket that was never
 * mounted is a gap in observability, not an outage, and must not paint the
 * whole console red every second on a box where it is simply not wired up.
 * TIMEOUT ranks above warning because a probe that hangs usually means the
 * thing behind it is genuinely sick.
 */
function rollup(statuses) {
  let worst = STATUS.HEALTHY;
  for (const s of statuses) {
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}

/**
 * A collector result. Every collector returns this shape, including on failure,
 * so the client never has to special-case a missing card.
 */
function result(name, { status, data = null, latency_ms = null, reason = null }) {
  return {
    name,
    status,
    data,
    latency_ms,
    // Why a card is not green, in words an operator can act on. Null when healthy.
    reason,
    checked_at: new Date().toISOString(),
  };
}

/** Marks a source that cannot be probed here — not an outage. */
function unavailable(name, reason) {
  return result(name, { status: STATUS.UNAVAILABLE, reason });
}

/**
 * Run one collector with its own deadline.
 *
 * Never rejects. A collector that throws becomes a CRITICAL card carrying the
 * message; one that hangs becomes TIMEOUT. Both are renderable.
 *
 * The timer is unref'd so a pending probe cannot hold the process open — the
 * same trick lib/queueHealth.js uses, and the reason its probes do not wedge
 * the test suite.
 */
async function runCollector(entry) {
  const { name, collect, timeoutMs } = entry;
  const started = Date.now();

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(result(name, {
        status: STATUS.TIMEOUT,
        latency_ms: Date.now() - started,
        reason: `Probe exceeded ${timeoutMs}ms`,
      })),
      timeoutMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });

  const work = (async () => {
    try {
      const value = await collect();
      // A collector may return a finished result (to set its own status and
      // reason) or just its data, in which case it is healthy by default.
      const out = value && typeof value === 'object' && 'status' in value
        ? { ...value, name }
        : result(name, { status: STATUS.HEALTHY, data: value });
      return { ...out, latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
    } catch (err) {
      logger.warn({ err: err.message, collector: name }, 'command-center collector failed');
      return result(name, {
        status: STATUS.CRITICAL,
        latency_ms: Date.now() - started,
        reason: err.message,
      });
    }
  })();

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map();

/**
 * @param {string} name        card id, stable — the client diffs on it
 * @param {Function} collect   async () => data | result
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=3000]
 * @param {number} [opts.ttlMs=0]  serve a cached value for this long. Sampling
 *   memory every second is free; asking Docker to list containers every second
 *   is not, and neither is a Postgres stats query.
 */
function register(name, collect, opts = {}) {
  if (registry.has(name)) throw new Error(`Collector already registered: ${name}`);
  if (typeof collect !== 'function') throw new Error(`Collector ${name} must be a function`);
  registry.set(name, {
    name,
    collect,
    timeoutMs: opts.timeoutMs ?? 3000,
    ttlMs: opts.ttlMs ?? 0,
  });
}

function get(name) { return registry.get(name) || null; }
function names() { return [...registry.keys()]; }
function clear() { registry.clear(); }

module.exports = {
  STATUS, SEVERITY_ORDER, rollup,
  result, unavailable, runCollector,
  register, get, names, clear,
};
