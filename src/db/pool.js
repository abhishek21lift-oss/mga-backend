// src/db/pool.js
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const logger = require('../lib/logger');
const { appTimeZone } = require('../lib/appTime');
const { currentOrgId } = require('../lib/tenant-context');

if (!process.env.DATABASE_URL) {
  logger.fatal('DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

/**
 * Is SSL explicitly turned OFF for this connection?
 *
 * Only `sslmode=disable` in the URL counts. Everything else — a different
 * sslmode, a malformed URL, no sslmode at all — leaves SSL ON, so this can
 * only ever be relaxed deliberately and never by an omission or a typo.
 *
 * It exists because a plain Postgres (a CI service container, a local docker)
 * is not built with SSL, and node-postgres asked for it unconditionally: the
 * server answers "not supported" and the driver fails the connection outright.
 * That is what broke the E2E job — the isolation suite could not reach a
 * database at all, so the one test that proves studios cannot read each
 * other's data had never actually run.
 *
 * The signal is read from DATABASE_URL rather than a separate env var so that
 * `psql` and this pool cannot disagree: libpq understands the same parameter,
 * so one URL configures both.
 *
 * Note that node-postgres does not implement libpq's `prefer` fallback (try
 * SSL, silently continue without it). Anything other than `disable` therefore
 * behaves as `require` here, which is the safe direction to be wrong in.
 */
function sslDisabledByUrl() {
  try {
    return new URL(process.env.DATABASE_URL).searchParams.get('sslmode') === 'disable';
  } catch {
    return false; // unparseable → keep SSL on
  }
}

// Build SSL config:
//   - sslmode=disable in the URL → no SSL at all (local/CI Postgres only).
//   - If DATABASE_SSL_CA is set, use that CA file with full cert verification.
//     This is the secure path for production — Supabase publishes a CA bundle.
//   - Otherwise fall back to rejectUnauthorized:false (Supabase-compatible
//     but doesn't verify the cert chain). Logs a warning so it's visible.
function buildSslConfig() {
  if (sslDisabledByUrl()) {
    // Loud on purpose. An unencrypted database connection is correct for a
    // throwaway CI container and alarming anywhere else, so it should never be
    // something you have to go looking for in a config file to discover.
    logger.warn('DATABASE_URL sets sslmode=disable — connecting WITHOUT encryption');
    return false;
  }
  const caPath = process.env.DATABASE_SSL_CA;
  if (caPath) {
    try {
      return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } catch (err) {
      logger.fatal({ caPath, err: err.message }, 'DATABASE_SSL_CA file could not be read');
      process.exit(1);
    }
  }
  // Supabase's Supavisor pooler uses a certificate chain that is not in the
  // standard system CA trust store (Render, AWS, etc.). rejectUnauthorized:false
  // keeps the connection encrypted but skips chain verification — this is the
  // approach Supabase officially recommends for pooler connections. Set
  // DATABASE_SSL_CA (above) to re-enable full chain verification.
  return { rejectUnauthorized: false };
}

const POOL_MAX = (() => {
  const n = parseInt(process.env.DATABASE_POOL_SIZE || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  max: POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // statement_timeout (server-side): PostgreSQL cancels the query after 20s.
  // query_timeout (client-side): node-postgres gives up waiting after 15s,
  // freeing the connection before the DB-side cancel fires.
  statement_timeout: 20000,
  query_timeout: 15000,
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'Unexpected DB pool error');
});

// Every connection speaks the studio's local time, not UTC.
//
// `CURRENT_DATE` is evaluated in the DATABASE session's TimeZone. That was
// never set, so it defaulted to the server's — UTC on Supabase. The studio is
// in India (UTC+05:30), which meant `session_date = CURRENT_DATE` did not
// become tomorrow at midnight IST; it became tomorrow at 05:30. For five and a
// half hours every night the dashboard, the month boundaries in the revenue
// queries and every `created_at::date` cast were all a day behind the studio
// looking at them.
//
// `SET TIME ZONE` on connect rather than an `options: '-c timezone=…'` startup
// parameter, which would be tidier — it is part of the handshake, so there is
// no window before it applies, and it does not trip node-postgres's warning
// about querying a client the pool is handing over. It is not used because
// production reaches Postgres through Supabase's Supavisor pooler, and poolers
// in the PgBouncer lineage reject startup parameters they do not recognise
// unless explicitly allowlisted. A rejected parameter is not a degraded
// connection, it is no connection at all — the whole backend fails to reach the
// database. A plain statement works through any pooler, so the deprecation
// warning is the cheaper of the two costs.
//
// SET TIME ZONE takes a string literal, not a bind parameter, so the value is
// validated by appTimeZone() before it gets here — one of a fixed set of IANA
// names, never raw user input.
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${appTimeZone()}'`).catch((err) => {
    // A connection that failed to take the zone would silently serve UTC
    // dates. Log it rather than swallow it; the query itself still works.
    logger.error({ err: err.message, tz: appTimeZone() }, 'Failed to set session time zone');
  });
});

// Off by default — see TENANT-RLS-PLAN.md and middleware/auth.js, which
// gates on the exact same env var so the two can never disagree about
// whether enforcement is "on". When on, a query running inside a request
// that resolved an org id (see auth.js) is wrapped in its own transaction
// that sets app.org_id via set_config() — the GUC the app_tenant RLS
// policies (157_app_tenant_role_and_rls.sql) read. Until DATABASE_URL
// actually points at app_tenant, this changes nothing observable: the
// connecting role still bypasses RLS, so the extra transaction runs for
// nothing but its own latency cost — which is precisely what flipping this
// flag on in staging (before touching DATABASE_URL) is for measuring.
const TENANT_RLS_ENFORCE = process.env.TENANT_RLS_ENFORCE === 'on';

/**
 * Runs `run()` on `client` inside BEGIN … SET LOCAL (via set_config) …
 * COMMIT, so app.org_id is visible to Postgres RLS for exactly this query's
 * duration and no other request's.
 *
 * set_config($1, $2, true) rather than `SET LOCAL app.org_id = '<value>'`
 * because SET does not accept a bind parameter — string-building an org id
 * into SQL text is exactly the injection shape a scoping layer must not
 * introduce, however well-formed org ids happen to be today.
 *
 * Exported so it is directly testable against a fake client, without
 * exercising this module's own pool.connect() startup call or a real
 * database.
 */
async function withOrgScope(client, orgId, run) {
  await client.query('BEGIN');
  try {
    const result = await (async () => {
      await client.query('SELECT set_config($1, $2, true)', ['app.org_id', String(orgId)]);
      return run();
    })();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// The pool's own methods, captured before either wrapper below replaces them.
// pool.query borrows through _origConnect rather than the patched pool.connect
// on purpose: it already scopes its borrowed client itself, via withOrgScope,
// and going through the patched connect would have the client's BEGIN
// interceptor emit set_config as well — the same value twice, one wasted round
// trip on every query, and two mechanisms responsible for one invariant.
const _origQuery = pool.query.bind(pool);
const _origConnect = pool.connect.bind(pool);

// Instrument pool.query to log slow queries (> 1 second) and, when
// TENANT_RLS_ENFORCE is on and the request resolved an org id, to run the
// query inside the org-scoping transaction above. The two compose: timing
// wraps the whole thing, so the added transaction's latency is exactly what
// shows up in slow_query — which is the number the staging rollout in
// TENANT-RLS-PLAN.md needs before this ever reaches production traffic.
pool.query = function slowQueryInstrument(...args) {
  const start = Date.now();
  const orgId = TENANT_RLS_ENFORCE ? currentOrgId() : null;
  const result = orgId == null
    ? _origQuery(...args)
    : _origConnect().then((client) =>
        withOrgScope(client, orgId, () => client.query(...args)).finally(() => client.release())
      );
  if (result && typeof result.then === 'function') {
    return result.then(
      (r) => {
        const ms = Date.now() - start;
        if (ms > 1000) {
          const sql = (typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '[object]')).slice(0, 200);
          logger.warn({ sql, ms }, 'slow_query');
        }
        return r;
      },
      (err) => { throw err; }
    );
  }
  return result;
};

/**
 * Puts app.org_id on a client the caller borrowed for its own transaction.
 *
 * pool.query's wrapper cannot reach these: 36 call sites do
 * `pool.connect()` → `BEGIN` → several statements → `COMMIT`, and the GUC has
 * to be set INSIDE that transaction, on that connection, or RLS sees nothing.
 * Left alone, the day DATABASE_URL points at app_tenant every one of those
 * paths — payments, invoices, enrolment — starts returning zero rows. Silently,
 * because RLS filters rather than errors.
 *
 * Rather than edit 36 transaction bodies, connect() is wrapped the same way
 * query() already is, so no call site changes. The client's own query method
 * is patched to notice the caller's BEGIN and follow it immediately with
 * set_config(..., true), which is transaction-scoped and therefore cannot
 * outlive the transaction or leak to whoever borrows this connection next.
 *
 * Three things it deliberately does NOT do:
 *
 *  · It does not scope queries run OUTSIDE a transaction. Those exist —
 *    the app has had such a path before — and silently
 *    wrapping them in transactions would change locking and DDL semantics that
 *    cannot be verified from here. They are logged instead, once per client, so
 *    the staging flag-on phase surfaces them as a list to work through rather
 *    than as a production incident.
 *  · It does not touch callback-style query(), which pg still supports. Every
 *    call site in this repo awaits, so this is a pass-through for completeness.
 *  · It does not run at all outside a request. currentOrgId() is undefined for
 *    migrations, the startup probe and cron, so those borrow an unpatched
 *    client exactly as before.
 *
 * The patch is removed on release(), because the pool hands the same physical
 * client out again — without that, each borrow would wrap the previous
 * wrapper and the stack would grow for the life of the process.
 */
const PRISTINE = Symbol.for('tenantScope.pristine');

function scopeClient(client, orgId, log = logger) {
  // The pristine methods, remembered once per physical client. Capturing
  // `client.query.bind(client)` instead would restore a BOUND COPY on release,
  // so the next borrow would bind that copy, and the chain would grow one
  // layer per borrow for the life of the process. Caught by the identity
  // assertion in tenantScopedClient.test.js.
  if (!client[PRISTINE]) {
    client[PRISTINE] = { query: client.query, release: client.release };
  }
  const { query: pristineQuery, release: pristineRelease } = client[PRISTINE];
  const origQuery = (...a) => pristineQuery.apply(client, a);
  const origRelease = (...a) => pristineRelease.apply(client, a);
  let inTransaction = false;
  let warned = false;

  const verbOf = (args) => {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
    return { sql, verb: sql.trimStart().slice(0, 24).toUpperCase() };
  };

  client.query = function scopedQuery(...args) {
    if (typeof args[args.length - 1] === 'function') return origQuery(...args);
    const { sql, verb } = verbOf(args);

    if (/^(BEGIN|START\s+TRANSACTION)/.test(verb)) {
      return origQuery(...args).then(async (res) => {
        await origQuery('SELECT set_config($1, $2, true)', ['app.org_id', String(orgId)]);
        inTransaction = true;
        return res;
      });
    }

    if (/^(COMMIT|ROLLBACK|END)\b/.test(verb)) {
      inTransaction = false;
      return origQuery(...args);
    }

    if (!inTransaction && !warned) {
      warned = true;
      log.warn(
        { sql: sql.slice(0, 120), orgId },
        'tenant_scope_gap: borrowed client ran a query outside a transaction, '
        + 'so app.org_id is not set for it — this statement would see no rows '
        + 'once DATABASE_URL points at app_tenant',
      );
    }
    return origQuery(...args);
  };

  client.release = function scopedRelease(...args) {
    client.query = pristineQuery;
    client.release = pristineRelease;
    return origRelease(...args);
  };

  return client;
}

// Same gate and the same source of truth as pool.query's wrapper above, so the
// two can never disagree about whether enforcement is on.
pool.connect = function tenantScopedConnect(...args) {
  const borrowed = _origConnect(...args);
  if (!TENANT_RLS_ENFORCE) return borrowed;
  return Promise.resolve(borrowed).then((client) => {
    const orgId = currentOrgId();
    return orgId == null ? client : scopeClient(client, orgId);
  });
};

// Exposed on the pool instance (not a separate module export — every
// existing call site does `const pool = require('../db/pool')` and expects
// pool itself to be the Pool) so it's directly testable without exercising
// this module's own pool.connect() startup call.
pool.withOrgScope = withOrgScope;
pool.scopeClient = scopeClient;

// Test connection on startup. Don't crash here — Render's healthcheck will
// surface a 5xx and you can read the log. Crashing prevents redeploys from
// recovering when Supabase has a brief connectivity blip.
//
// Skipped under test. This is a deploy-time readiness probe, and it has no
// value in a Jest worker: it opens a connection on import, which frequently
// outlives the suite that triggered it. Jest then tears the module registry
// down and pg's lazy `require('net')` inside the TLS branch returns undefined,
// surfacing as "Cannot read properties of undefined (reading 'isIP')" against
// an unrelated test. jest.setup.env.js already prevents the URL from pointing
// anywhere real; this stops the connection being attempted at all.
if (process.env.NODE_ENV !== 'test') {
pool.connect()
  .then(client => {
    logger.info('Connected to Supabase PostgreSQL');
    client.release();
  })
  .catch(err => {
    logger.error({ err: err.message }, 'Database connection failed on startup');
    logger.error('  1. Check DATABASE_URL is set in your .env / Render env');
    logger.error('  2. Check the Supabase project is not paused');
    logger.error('  3. Check the password in the URI matches your DB password');
  });
}

module.exports = pool;
