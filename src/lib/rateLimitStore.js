'use strict';
// Shared rate-limit storage.
//
// Audit finding H-4. Every limiter in this app used express-rate-limit's
// DEFAULT store, which is an in-process Map. That is correct for exactly one
// api container and quietly wrong for two: each replica keeps its own counters,
// so "30 login attempts per 15 minutes" becomes 30 x N for anyone who gets
// round-robined across instances. The protection does not fail loudly when the
// service scales out — it just silently weakens, which is the worst way for a
// brute-force control to break.
//
// Redis was already a hard dependency of this stack (BullMQ runs five queues
// through it, and the worker container cannot start without it), so this needs
// no new infrastructure — only a second consumer of the one already there.
//
// ── Why this degrades instead of failing ────────────────────────────────────
//
// redis.js is explicit that Redis is OPTIONAL: the app boots and works without
// it, just without retries and backoff. Rate limiting has to hold that same
// contract, in two places:
//
//   1. Not configured at all -> return undefined, and express-rate-limit uses
//      its in-memory store exactly as before. A single-container or local dev
//      setup is unaffected by any of this.
//   2. Configured but unreachable mid-request -> the caller pairs this store
//      with `passOnStoreError: true`, so a Redis blip lets the request through
//      rather than turning every API call into a 500.
//
// (2) is a deliberate trade. Failing OPEN briefly weakens the limiter; failing
// closed would take the whole API down whenever Redis hiccups. For a limiter
// that is a denial-of-service control rather than an authorization boundary,
// availability wins — and it is strictly better than the status quo, where the
// counters were per-process anyway.

const { RedisStore } = require('rate-limit-redis');
const redis = require('./redis');
const logger = require('./logger');

let warnedUnavailable = false;

/**
 * Build a store for one limiter.
 *
 * @param {string} prefix Namespace for this limiter's keys. MUST be unique per
 *   limiter — every limiter sharing a prefix would share one counter, so the
 *   login limiter would consume the general API budget and vice versa.
 * @returns {object|undefined} A RedisStore, or undefined to mean "use the
 *   default in-memory store".
 */
function makeStore(prefix) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('makeStore(prefix) requires a unique string prefix');
  }

  if (!redis.isConfigured()) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      logger.warn(
        'Redis is not configured — rate limits are per-process. Correct for a '
        + 'single container; running more than one api replica this way multiplies '
        + 'every limit by the replica count.'
      );
    }
    return undefined;
  }

  const client = redis.getConnection();

  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // ioredis speaks `call(command, ...args)`. rate-limit-redis hands us the
    // command and its arguments already split, so this is a straight forward.
    sendCommand: (...args) => client.call(...args),
  });
}

module.exports = { makeStore };
