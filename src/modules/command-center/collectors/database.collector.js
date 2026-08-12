// src/modules/command-center/collectors/database.collector.js
//
// PostgreSQL health: pool, connections, slow queries, size, migrations.
//
// Every query here is bounded and read-only, and each optional part is wrapped
// on its own so a restricted role loses one field rather than the whole card.
// pg_stat_statements IS installed on this project (checked against the live
// database), so the slow-query panel has a real source — but it stays optional
// because a restore or a different environment may not have it.
//
// The pool numbers are the ones that predict an outage. `waiting > 0` means
// requests are already queued behind a connection that has not come back, and
// it shows up here before users notice, which is the whole point of the card.
'use strict';

const { STATUS, result } = require('../registry');
const pool = require('../../../db/pool');

const NAME = 'database';

const LATENCY_WARN_MS = Number(process.env.CC_DB_LATENCY_WARN_MS) || 100;
const LATENCY_CRIT_MS = Number(process.env.CC_DB_LATENCY_CRIT_MS) || 500;
const CONN_WARN = 0.70;
const CONN_CRIT = 0.85;
const SLOW_QUERY_MS = Number(process.env.CC_SLOW_QUERY_MS) || 1000;

/** Run an optional probe; a failure costs that field, not the card. */
async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

async function collect() {
  const t0 = Date.now();
  await pool.query('SELECT 1');
  const latency = Date.now() - t0;

  const [connections, size, migrations, longest, slowest, txWrap] = await Promise.all([
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE state = 'active')::int AS active,
               count(*) FILTER (WHERE state = 'idle')::int AS idle,
               count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
               current_setting('max_connections')::int AS max_connections
          FROM pg_stat_activity
         WHERE datname = current_database()`);
      return rows[0];
    }),
    optional(async () => {
      const { rows } = await pool.query(
        'SELECT pg_database_size(current_database())::bigint AS bytes');
      return Number(rows[0].bytes);
    }),
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS applied,
               (SELECT filename   FROM _migrations ORDER BY id DESC LIMIT 1) AS latest,
               (SELECT applied_at FROM _migrations ORDER BY id DESC LIMIT 1) AS applied_at
          FROM _migrations`);
      return rows[0];
    }),
    // The single longest-running statement right now. A query stuck for minutes
    // is usually what is holding the connections the pool is waiting for.
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT pid,
               EXTRACT(MILLISECONDS FROM (now() - query_start))::bigint AS duration_ms,
               state,
               left(query, 200) AS query
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'active'
           AND query_start IS NOT NULL
           AND pid <> pg_backend_pid()
         ORDER BY query_start ASC
         LIMIT 1`);
      return rows[0] ? { ...rows[0], duration_ms: Number(rows[0].duration_ms) } : null;
    }),
    // Historical worst offenders. Optional: pg_stat_statements may be absent.
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT left(query, 200) AS query,
               calls::bigint,
               round(mean_exec_time::numeric, 2)::float8 AS mean_ms,
               round(max_exec_time::numeric, 2)::float8  AS max_ms,
               round(total_exec_time::numeric, 2)::float8 AS total_ms
          FROM pg_stat_statements
         WHERE mean_exec_time > $1
         ORDER BY mean_exec_time DESC
         LIMIT 5`, [SLOW_QUERY_MS]);
      return rows.map((r) => ({ ...r, calls: Number(r.calls) }));
    }, null),
    // An idle-in-transaction session pins its snapshot and blocks vacuum; left
    // long enough it is how a database runs out of transaction ids.
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS n
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'idle in transaction'
           AND state_change < now() - interval '5 minutes'`);
      return rows[0].n;
    }, null),
  ]);

  const connRatio = connections && connections.max_connections
    ? connections.total / connections.max_connections
    : null;

  const data = {
    status: 'up',
    latency_ms: latency,
    // The app's own pool, distinct from the server's connection count above.
    pool: {
      total: pool.totalCount ?? null,
      idle: pool.idleCount ?? null,
      waiting: pool.waitingCount ?? null,
    },
    connections: connections
      ? { ...connections, used_ratio: connRatio == null ? null : Math.round(connRatio * 1000) / 1000 }
      : null,
    size_bytes: size,
    migrations,
    longest_running_query: longest,
    slow_queries: slowest,
    slow_query_source: slowest === null ? 'pg_stat_statements unavailable' : 'pg_stat_statements',
    stale_idle_in_transaction: txWrap,
  };

  let status = STATUS.HEALTHY;
  let reason = null;
  if (latency >= LATENCY_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `Database latency ${latency}ms`;
  } else if (connRatio != null && connRatio >= CONN_CRIT) {
    status = STATUS.CRITICAL;
    reason = `${connections.total}/${connections.max_connections} connections used`;
  } else if ((pool.waitingCount ?? 0) > 0) {
    status = STATUS.WARNING;
    reason = `${pool.waitingCount} request(s) waiting for a pool connection`;
  } else if (connRatio != null && connRatio >= CONN_WARN) {
    status = STATUS.WARNING;
    reason = `${connections.total}/${connections.max_connections} connections used`;
  } else if (latency >= LATENCY_WARN_MS) {
    status = STATUS.WARNING;
    reason = `Database latency ${latency}ms`;
  } else if (txWrap > 0) {
    status = STATUS.WARNING;
    reason = `${txWrap} session(s) idle in transaction over 5 minutes — blocking vacuum`;
  }

  return result(NAME, { status, data, reason, latency_ms: latency });
}

module.exports = {
  NAME, collect,
  LATENCY_WARN_MS, LATENCY_CRIT_MS, CONN_WARN, CONN_CRIT, SLOW_QUERY_MS,
};
