// src/modules/command-center/collectors/redis.collector.js
//
// Redis health, via the ONE shared client in lib/redis.js.
//
// The brief's §18 says do not duplicate Redis connections, and it is not a
// style point here: this app runs BullMQ, and an extra client is an extra
// connection against a container capped at `maxmemory 256mb` with
// `maxmemory-policy noeviction`. Under pressure that policy makes writes fail
// rather than silently dropping job hashes — which is correct, and which also
// means every connection we add is a connection that can contribute to the
// pressure that breaks the queue. So: lib/redis.js only.
//
// The memory figure matters more than usual for the same reason. At noeviction,
// hitting maxmemory does not degrade gracefully — enqueues start erroring. The
// thresholds below are set to warn well before that edge.
'use strict';

const { STATUS, result, unavailable } = require('../registry');
const redis = require('../../../lib/redis');

const NAME = 'redis';

const LATENCY_WARN_MS = Number(process.env.CC_REDIS_LATENCY_WARN_MS) || 50;
const LATENCY_CRIT_MS = Number(process.env.CC_REDIS_LATENCY_CRIT_MS) || 250;
const MEM_WARN = 0.75;
const MEM_CRIT = 0.90;

/** Parse redis INFO's `key:value\r\n` blocks into a flat object. */
function parseInfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i === -1) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function collect() {
  // Not configured is not a failure. Without REDIS_URL the app falls back to
  // inline sends by design (see docker-compose.yml's header), so this card
  // should say "off", not "broken".
  if (!redis.isConfigured()) {
    return unavailable(NAME, 'REDIS_URL is not set — queues run inline');
  }

  const t0 = Date.now();
  await redis.ping();
  const latency = Date.now() - t0;

  const client = redis.getClient();
  let info = {};
  try {
    const [memory, clients, stats, server] = await Promise.all([
      client.info('memory'),
      client.info('clients'),
      client.info('stats'),
      client.info('server'),
    ]);
    info = {
      ...parseInfo(memory), ...parseInfo(clients),
      ...parseInfo(stats), ...parseInfo(server),
    };
  } catch {
    // A managed Redis may restrict INFO. Latency alone still makes the card
    // useful, so this degrades rather than fails.
    info = {};
  }

  const usedBytes = num(info.used_memory);
  const maxBytes = num(info.maxmemory);
  // maxmemory reports 0 when unlimited; a ratio against 0 is meaningless.
  const ratio = usedBytes != null && maxBytes ? usedBytes / maxBytes : null;

  const data = {
    connected: true,
    latency_ms: latency,
    ready: redis.isReady(),
    memory: {
      used_bytes: usedBytes,
      used_human: info.used_memory_human ?? null,
      peak_bytes: num(info.used_memory_peak),
      max_bytes: maxBytes || null,
      used_ratio: ratio == null ? null : Math.round(ratio * 1000) / 1000,
      // noeviction means hitting the cap fails writes instead of evicting.
      policy: info.maxmemory_policy ?? null,
    },
    clients: {
      connected: num(info.connected_clients),
      blocked: num(info.blocked_clients),
    },
    stats: {
      ops_per_sec: num(info.instantaneous_ops_per_sec),
      total_connections: num(info.total_connections_received),
      rejected_connections: num(info.rejected_connections),
      keyspace_hits: num(info.keyspace_hits),
      keyspace_misses: num(info.keyspace_misses),
    },
    server: {
      version: info.redis_version ?? null,
      uptime_seconds: num(info.uptime_in_seconds),
    },
  };

  let status = STATUS.HEALTHY;
  let reason = null;
  if (latency >= LATENCY_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `Redis latency ${latency}ms`;
  } else if (ratio != null && ratio >= MEM_CRIT) {
    status = STATUS.CRITICAL;
    reason = `Redis memory ${Math.round(ratio * 100)}% of maxmemory — at noeviction, enqueues will start failing`;
  } else if (ratio != null && ratio >= MEM_WARN) {
    status = STATUS.WARNING;
    reason = `Redis memory ${Math.round(ratio * 100)}% of maxmemory`;
  } else if (latency >= LATENCY_WARN_MS) {
    status = STATUS.WARNING;
    reason = `Redis latency ${latency}ms`;
  } else if (num(info.rejected_connections) > 0) {
    status = STATUS.WARNING;
    reason = `${info.rejected_connections} rejected connections — maxclients may be too low`;
  }

  return result(NAME, { status, data, reason, latency_ms: latency });
}

module.exports = { NAME, collect, parseInfo, LATENCY_WARN_MS, LATENCY_CRIT_MS, MEM_WARN, MEM_CRIT };
