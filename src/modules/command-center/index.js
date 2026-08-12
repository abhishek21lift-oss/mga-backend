// src/modules/command-center/index.js
//
// Registers the Phase 1 collectors and re-exports the pieces the routes use.
//
// Registration happens here, once, rather than inside each collector file, so
// that requiring a collector in a test does not mutate global state — the
// registry throws on a duplicate name, and a self-registering module makes that
// unavoidable the moment two test files import it.
//
// The TTLs are the interesting part. Everything is sampled on a 1s tick for the
// WebSocket, but not everything should be PROBED every second:
//
//   runtime   0ms  — reading process counters is free, and the event-loop
//                    histogram is reset on read, so caching it would silently
//                    widen the window each sample covers.
//   redis     1s   — one PING plus four INFO calls; cheap, but not free against
//                    a 256mb box also carrying the queue.
//   queues    2s   — six BullMQ count calls per collect, each its own round
//                    trip. At 1s this would be the dominant Redis load.
//   database  5s   — pg_stat_activity and pg_stat_statements scan server-wide
//                    state. Polling those every second adds real load to the
//                    thing we are trying to keep healthy.
'use strict';

const registry = require('./registry');
const snapshot = require('./snapshot.service');

const runtime = require('./collectors/runtime.collector');
const redisCollector = require('./collectors/redis.collector');
const queueCollector = require('./collectors/queue.collector');
const databaseCollector = require('./collectors/database.collector');
const aiCollector = require('./collectors/ai.collector');
const smtpCollector = require('./collectors/smtp.collector');
const securityCollector = require('./collectors/security.collector');
const httpCollector = require('./collectors/http.collector');

let registered = false;

/** Idempotent: server.js and the tests may both call this. */
function registerCollectors() {
  if (registered) return;
  registry.register(runtime.NAME, runtime.collect, { timeoutMs: 1000, ttlMs: 0 });
  registry.register(redisCollector.NAME, redisCollector.collect, { timeoutMs: 3000, ttlMs: 1000 });
  registry.register(queueCollector.NAME, queueCollector.collect, { timeoutMs: 5000, ttlMs: 2000 });
  registry.register(databaseCollector.NAME, databaseCollector.collect, { timeoutMs: 5000, ttlMs: 5000 });
  // http reads an in-memory ring — free, so no cache.
  registry.register(httpCollector.NAME, httpCollector.collect, { timeoutMs: 1000, ttlMs: 0 });
  // ai/security aggregate over log tables; 10s is well inside a useful window
  // and keeps the console off the product's own database load.
  registry.register(aiCollector.NAME, aiCollector.collect, { timeoutMs: 5000, ttlMs: 10_000 });
  registry.register(securityCollector.NAME, securityCollector.collect, { timeoutMs: 5000, ttlMs: 10_000 });
  // smtp's default probe is config + delivery history, no handshake; 30s
  // because none of that changes second to second.
  registry.register(smtpCollector.NAME, smtpCollector.collect, { timeoutMs: 5000, ttlMs: 30_000 });
  registered = true;
}

function reset() {
  registry.clear();
  snapshot.invalidate();
  registered = false;
}

module.exports = { registerCollectors, reset, registry, snapshot };
