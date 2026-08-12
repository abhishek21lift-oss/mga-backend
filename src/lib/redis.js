// src/lib/redis.js
// Single source of truth for every Redis connection in this process.
//
// BullMQ needs `maxRetriesPerRequest: null` (blocking commands must never be
// retried by the driver, BullMQ owns retries), so that option lives on the
// one client factory here rather than being re-argued at every call site.
//
// One shared, lazily-connected client is used by:
//   - the /api/health check (ping)
//   - every BullMQ *producer* Queue in the API process (non-blocking commands)
//
// BullMQ *workers* get their own client via getWorkerConnection(): a consumer
// issues blocking commands (BZPOPMIN) that would stall a shared connection and
// starve every other user of it. One extra connection per worker is required
// by the protocol, not duplication — they all still derive from the same
// options object below.

const Redis = require('ioredis');
const logger = require('./logger');

const DEFAULT_HOST = 'redis';

// ioredis v6 removed Redis.parseURL(), so REDIS_URL is parsed here with the
// WHATWG URL parser. Handles redis://, rediss:// (TLS) and the optional
// [:password@]host[:port][/db] parts. Usernames are ignored (ioredis uses the
// password field alone; if REDIS_USERNAME is set it is passed through below).
function parseRedisUrl(raw) {
  try {
    const u = new URL(raw);
    const db = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
    return {
      scheme: u.protocol.replace(':', ''),
      hostname: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: Number.isFinite(db) ? db : undefined,
    };
  } catch {
    return null;
  }
}

function resolveOptions(env = process.env) {
  const url = env.REDIS_URL;
  const base = {
    host: env.REDIS_HOST || DEFAULT_HOST,
    port: Number(env.REDIS_PORT ?? 6379) || 6379,
  };
  // A connection string wins when present; host/port still fall back above
  // so a bare REDIS_URL never leaves host/port undefined.
  const parsed = url ? parseRedisUrl(url) : null;

  const options = {
    ...base,
    host: parsed?.hostname || base.host,
    port: parsed?.port || base.port,
    username: env.REDIS_USERNAME || undefined,
    password: parsed?.password || env.REDIS_PASSWORD || undefined,
    db: parsed?.db ?? (env.REDIS_DB ? Number(env.REDIS_DB) : 0),
    // Required by BullMQ: the driver must not cap retries on blocking
    // commands; queue-level retry/backoff is BullMQ's job.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Never connect at import time — a deploy without Redis must boot (and
    // fall back to inline sends / degraded health) rather than hang.
    lazyConnect: true,
    // TLS for managed Redis providers (Upstash, Render Redis, ElastiCache).
    // REDIS_TLS=1 forces it; REDIS_URL of scheme rediss:// implies it.
    tls: (parsed && parsed.scheme === 'rediss') || env.REDIS_TLS === '1'
      ? {}
      : undefined,
  };

  return {
    options,
    configured:
      Boolean(url) ||
      Boolean(env.REDIS_HOST) ||
      Boolean(env.REDIS_PORT) ||
      Boolean(env.REDIS_PASSWORD) ||
      Boolean(env.REDIS_USERNAME) ||
      Boolean(env.REDIS_TLS),
  };
}

const { options: redisOptions, configured: _configured } = resolveOptions();

let redisClient;

function createRedisClient() {
  const client = new Redis(redisOptions);

  client.on('connect', () => {
    logger.info({ host: redisOptions.host, port: redisOptions.port }, 'Redis connected');
  });

  client.on('ready', () => {
    logger.info({ host: redisOptions.host, port: redisOptions.port }, 'Redis ready');
  });

  client.on('error', (err) => {
    logger.error({ err, host: redisOptions.host, port: redisOptions.port }, 'Redis error');
  });

  client.on('close', () => {
    logger.warn({ host: redisOptions.host, port: redisOptions.port }, 'Redis connection closed');
  });

  return client;
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

/**
 * The shared producer connection. Safe to pass to every BullMQ Queue in this
 * process: producers only ever issue non-blocking commands.
 */
function getConnection() {
  return getRedisClient();
}

/**
 * A dedicated client for a BullMQ Worker. Workers issue blocking commands and
 * MUST NOT share a connection with anything else in the process.
 */
function getWorkerConnection() {
  return createRedisClient();
}

/**
 * True when the shared client is actually connected (status === 'ready').
 * Producers use this to decide queue-vs-inline: never enqueue into a dead
 * Redis — fall back to the synchronous path instead.
 */
function isReady() {
  return getRedisClient().status === 'ready';
}

/** True when Redis was explicitly configured via the environment. */
function isConfigured() {
  return _configured;
}

/**
 * Bring the shared client to a usable state when Redis is configured:
 * connects if idle and waits up to `timeoutMs` for 'ready'. Returns false when
 * Redis is not configured, or the connection cannot be established in time —
 * producers use that to fall back to inline delivery rather than hang or
 * throw. Bounded by design: an unreachable Redis must cost a little latency,
 * never the request. Connection-refused fails fast; the timeout only bites
 * when the host is unreachable enough to hang.
 */
async function ensureReady(timeoutMs = 2000) {
  if (!isConfigured()) return false;
  const client = getRedisClient();
  if (client.status === 'ready') return true;
  // ioredis auto-reconnects from 'close'/'end' itself; while it is doing so
  // there is nothing to wait for that won't hang, so producers degrade inline.
  if (client.status === 'close' || client.status === 'end') return false;
  try {
    if (client.status !== 'connecting' && client.status !== 'connect') {
      await client.connect();
    }
    if (client.status === 'ready') return true;
    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
      }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('redis connect timeout')), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded ping so a health probe can never hang on an unreachable Redis
 * (a bare client.ping() waits indefinitely while the driver retries).
 */
async function ping(timeoutMs = 5000) {
  if (!(await ensureReady(timeoutMs))) throw new Error('redis unavailable');
  return getRedisClient().ping();
}

/** Close the shared client (used by graceful shutdown). */
async function close() {
  if (!redisClient) return;
  const c = redisClient;
  redisClient = undefined;
  try {
    await c.quit();
  } catch (err) {
    logger.warn({ err: err.message }, 'Redis close failed');
    c.disconnect();
  }
}

module.exports = {
  getClient: getRedisClient,
  ping,
  ensureReady,
  isReady,
  isConfigured,
  getConnection,
  getWorkerConnection,
  close,
  redisOptions,
};
