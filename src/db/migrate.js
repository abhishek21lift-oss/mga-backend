// src/db/migrate.js
// Run all pending SQL migrations in order.
//
// Two modes:
//   1. CLI:    node src/db/migrate.js   (closes pool when done)
//   2. Module: require('./migrate').runMigrations()  (pool stays open)
//              Called automatically from server.js on startup.

// ── Read before anything else in this file ──────────────────────────────────
//
// Captured HERE, above the requires, because ./pool calls dotenv.config() on
// import. From the line below onwards, .env has been merged into process.env
// and there is no way left to tell a value the operator typed from a value a
// local file supplied.
//
// That distinction is the whole point. .env is local developer configuration;
// it is also where a production MIGRATION_DATABASE_URL naturally ends up, and
// server.js runs runMigrationsWithRetry() on every boot. The combination meant
// `npm run dev` on a laptop migrated the production database — not as an edge
// case but as the default, and it is how migration 162 reached Supabase
// without anyone deciding it should.
//
// So the escape hatch is deliberately NOT readable from .env. Adding
// MIGRATION_ALLOW_REMOTE=1 to that file does nothing; it has to be supplied on
// the command line, which is a thing a person does on purpose.
const ALLOW_REMOTE = process.env.MIGRATION_ALLOW_REMOTE === '1';

const fs   = require('fs');
const path = require('path');
const pool = require('./pool');

/**
 * The connection migrations run on — privileged, and separate from the one the
 * application serves traffic with.
 *
 * Migrations do DDL. The application role deliberately cannot: `app_tenant` is
 * created NOSUPERUSER with no CREATE on schema public, because a runtime role
 * that can reshape the schema is a much larger blast radius than one that can
 * only read and write rows. Those two requirements are irreconcilable on one
 * connection, and previously there was only one — so pointing DATABASE_URL at
 * app_tenant made the server fail to boot at all:
 *
 *     migration attempt 1/5 failed: permission denied for schema public
 *
 * That is the correct refusal, not a bug to grant away. So migrations use
 * MIGRATION_DATABASE_URL when it is set, and DATABASE_URL when it is not —
 * which keeps every existing deployment working unchanged, since today both
 * roles are the same role.
 *
 * The migration pool is deliberately a plain Pool, not the shared one from
 * ./pool: that instance is wrapped to inject app.org_id per request, and a
 * schema migration is a platform operation with no tenant to scope it to.
 */
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL || null;

/**
 * Hosts that cannot be somebody else's database. Everything else is remote,
 * including a private IP — a colleague's machine on the same network is still
 * not this machine.
 */
const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'postgres', 'db',
]);

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };

/**
 * Refuse to migrate a database this command was not obviously meant to touch.
 *
 * Deliberately not a check on "is this Supabase" or "is this production" —
 * neither is knowable from a URL, and a rule that guesses is a rule that is
 * wrong on the day it matters. The question asked instead is answerable:
 * is the target on this machine, and if not, did a human say so?
 *
 * Three ways through, in the order they are asked:
 *
 *   · the target is local            — nothing to protect
 *   · NODE_ENV=production            — a deploy migrating its own database is
 *                                      the entire point, and Render sets this
 *   · MIGRATION_ALLOW_REMOTE=1       — supplied on the command line, above
 *
 * Everything else stops. The message names the host so the mistake is obvious,
 * and never the URL, which carries the password.
 */
function assertTargetIsIntentional() {
  const url = MIGRATION_URL || process.env.DATABASE_URL || '';
  const host = hostOf(url);

  if (!host) return;                              // nothing resolvable to judge
  if (LOCAL_HOSTS.has(host)) return;
  if (process.env.NODE_ENV === 'production') return;
  if (ALLOW_REMOTE) return;

  const via = MIGRATION_URL ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL';
  const err = new Error(
    `refusing to migrate a remote database from a non-production process.\n`
    + `    target : ${host}  (via ${via})\n`
    + `    reason : NODE_ENV is ${process.env.NODE_ENV || 'unset'}, and this host is not local.\n`
    + `             .env is developer configuration and server.js migrates on boot, so a\n`
    + `             production URL there would be applied by \`npm run dev\`.\n`
    + `    fix    : point ${via} at a local database, or if you really mean this one:\n`
    + `             npm run migrate:remote        (asks for confirmation)\n`
    + `             MIGRATION_ALLOW_REMOTE=1 node src/db/migrate.js\n`
    + `             Setting MIGRATION_ALLOW_REMOTE in .env has no effect, by design.`,
  );
  // Retrying a refusal five times helps nobody and buries the message.
  err.isSafetyRefusal = true;
  throw err;
}

function migrationPool() {
  if (!MIGRATION_URL) return { pool, release: () => {} };
  // Required lazily so a deployment that never sets the variable pays nothing.
  const { Pool } = require('pg');
  const dedicated = new Pool({
    connectionString: MIGRATION_URL,
    ssl: new URL(MIGRATION_URL).searchParams.get('sslmode') === 'disable'
      ? false
      : { rejectUnauthorized: false },
    max: 1,                       // one migration at a time, by design
    connectionTimeoutMillis: 30_000,
  });
  return { pool: dedicated, release: () => dedicated.end().catch(() => {}) };
}

/**
 * The foundation marker recorded in _migrations once schema.sql has been
 * applied.
 *
 * Deliberately not a plausible filename: it carries a slash, which no
 * basename from readdirSync(migrations) ever will, so it can never collide
 * with a real migration and can never be mistaken for one when reading the
 * table by hand. The runner's UNIQUE(filename) column stores it as-is.
 */
const FOUNDATION_MARKER = 'foundation/schema-v4.sql';

/**
 * Apply src/db/schema.sql — the foundational schema the migration chain
 * assumes already exists.
 *
 * ── Why this is needed ────────────────────────────────────────────────────
 *
 * runMigrations() globs migrations/*.sql, and schema.sql sits one directory
 * above that, so it was never applied by anything. On a database that already
 * had the v3/v4 schema (every deployment to date) this was invisible. Against
 * a genuinely empty database it is fatal at the very first file: verified on
 * PostgreSQL 17.10, migrations alone apply 0 of 169 and fail with
 * `42P01 relation "clients" does not exist`, because 001_v4_upgrade.sql is —
 * as its own header says — an upgrade for an existing v3 database. With the
 * foundation applied first, 166 of 169 apply; the three that do not are
 * blocked solely by pgvector being unavailable in that test environment.
 *
 * ── Why it is safe to run against an existing database ────────────────────
 *
 * schema.sql was audited construct by construct and is idempotent throughout:
 * every CREATE TABLE/INDEX/EXTENSION carries IF NOT EXISTS, the five enum
 * types are wrapped in `EXCEPTION WHEN duplicate_object`, the two ALTER TABLE
 * constraints test pg_constraint first, the updated_at trigger tests
 * pg_trigger, the function is CREATE OR REPLACE, and all four seed INSERTs
 * are ON CONFLICT DO NOTHING or guarded by NOT EXISTS. It contains no DROP
 * and no TRUNCATE, so it cannot destroy an existing schema or its data.
 *
 * It therefore runs at most once per database (guarded by the marker below),
 * and even if it ran again it would be a no-op rather than a hazard.
 */
async function applyFoundation(client) {
  const { rows } = await client.query(
    'SELECT id FROM _migrations WHERE filename=$1', [FOUNDATION_MARKER]
  );
  if (rows.length > 0) {
    console.log(`  ✓ ${FOUNDATION_MARKER} (already applied)`);
    return;
  }

  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    // Not fatal: a deployment that has already been migrated does not need
    // the foundation, and refusing to boot over a missing file would turn a
    // packaging slip into an outage. Loud, though — on an empty database the
    // next statement is the one that fails.
    console.warn(`  ! ${schemaPath} not found — skipping foundation`);
    return;
  }

  console.log(`  → Applying ${FOUNDATION_MARKER}…`);
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [FOUNDATION_MARKER]);
    await client.query('COMMIT');
    console.log(`  ✓ ${FOUNDATION_MARKER} applied`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ✗ ${FOUNDATION_MARKER} FAILED:`, err.message);
    throw err;
  }
}

/**
 * Apply any pending migrations from src/db/migrations/*.sql.
 * Safe to call on every startup — already-applied files are skipped.
 * Does NOT close the pool so the server can keep using it.
 */
const LOCK_ID = 619619619; // Unique advisory lock for 619 ERP migrations

/**
 * Terminate any *orphaned* holder of the migration advisory lock.
 *
 * A session-level advisory lock survives a SIGKILL'd boot: the pooled backend
 * behind Supavisor lingers, still holding the lock, and blocks every later
 * boot until it's reaped (which can take minutes and fail the deploy). Such a
 * holder is idle — it grabbed the lock and then its client vanished. We
 * terminate ONLY holders that are idle (or idle-in-transaction) and have been
 * so for a while, so a peer instance that is actively migrating (state
 * 'active', or briefly between fast sub-second statements) is never touched.
 * pg_advisory_lock(bigint) with a key < 2^32 stores classid=0, objid=key.
 */
async function clearStaleLock(client) {
  try {
    const { rows } = await client.query(
      `SELECT a.pid
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1
          AND a.pid <> pg_backend_pid()
          AND a.state IN ('idle', 'idle in transaction')
          AND a.state_change < now() - interval '15 seconds'`,
      [LOCK_ID]
    );
    for (const r of rows) {
      const { rows: k } = await client.query('SELECT pg_terminate_backend($1) AS ok', [r.pid]);
      if (k[0].ok) console.log(`  ⚠ terminated stale migration-lock holder (pid ${r.pid})`);
    }
    return rows.length;
  } catch (err) {
    console.warn(`  … could not check/clear stale migration lock: ${err.message}`);
    return 0;
  }
}

async function runMigrations() {
  // Before a connection is opened, let alone a statement run.
  assertTargetIsIntentional();

  const { pool: mpool, release: releasePool } = migrationPool();
  if (MIGRATION_URL) console.log('  · migrating via MIGRATION_DATABASE_URL (privileged role)');
  const client = await mpool.connect();
  let holdsLock = false;
  try {
    // Acquire the advisory lock WITHOUT blocking. A blocking pg_advisory_lock()
    // sits in the lock queue, where the pool's statement_timeout/query_timeout
    // eventually kills it — and under crash-loop restarts that piles up waiters
    // and orphans lock-holding sessions behind the Supavisor pooler (a boot
    // grabs the lock, the container is SIGKILLed mid-migration, and the pooled
    // backend lingers still holding it, blocking every later boot). Polling a
    // non-blocking pg_try_advisory_lock never queues, so a stale holder just
    // makes us retry rather than deadlock the whole service. lock_timeout is a
    // belt-and-braces guard for any other lock this session waits on.
    await client.query("SET lock_timeout = '5s'");
    for (let attempt = 1; attempt <= 15; attempt++) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      if (rows[0].ok) { holdsLock = true; break; }
      console.log(`  … migration lock held by another instance, retry ${attempt}/15`);
      // After a few failed tries the holder is likely orphaned, not a live
      // migrator — actively terminate it so we don't wait out the full window
      // (and fail the deploy) for a lock nobody will ever release.
      if (attempt >= 3) await clearStaleLock(client);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!holdsLock) {
      throw new Error('Could not acquire migration advisory lock (another instance may be migrating or a stale lock is held)');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await applyFoundation(client);

    const dir   = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename=$1', [file]
      );
      if (rows.length > 0) {
        console.log(`  ✓ ${file} (already applied)`);
        continue;
      }
      console.log(`  → Applying ${file}…`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file} FAILED:`, err.message);
        throw err;
      }
    }
    console.log('✅ All migrations complete.');
  } finally {
    if (holdsLock) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(function() {});
    }
    client.release();
    // Only closes the dedicated migration pool; the shared application pool is
    // left open, because the server keeps serving requests on it.
    await releasePool();
  }
}

/**
 * Run migrations, retrying on transient connection/query failures.
 *
 * On a cold start (Render waking from hibernate, or the Supabase pooler
 * spinning up) the first DB connection can take longer than the pool's
 * connectionTimeoutMillis, so pool.connect() rejects with "Connection
 * terminated due to connection timeout" or a "Query read timeout". A single
 * failure used to exit(1) and crash-loop the whole service; retrying with
 * backoff lets the boot ride out that initial blip. The migration runner is
 * idempotent (already-applied files are skipped, each file is transactional),
 * so re-running is always safe.
 */
async function runMigrationsWithRetry({ attempts = 5, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      lastErr = err;
      // A refusal is a decision, not a transient fault. Retrying it four more
      // times only pushes the explanation off the top of the log.
      if (err.isSafetyRefusal) throw err;
      console.error(`  ⚠ migration attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
      console.error(`    retrying in ${delay / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// When executed directly as CLI, close the pool after finishing.
if (require.main === module) {
  require('dotenv').config();
  runMigrations()
    .then(() => pool.end())
    .catch(err => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations, runMigrationsWithRetry };
