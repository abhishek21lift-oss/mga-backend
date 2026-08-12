// src/db/migrate.js
// Run all pending SQL migrations in order.
//
// Two modes:
//   1. CLI:    node src/db/migrate.js   (closes pool when done)
//   2. Module: require('./migrate').runMigrations()  (pool stays open)
//              Called automatically from server.js on startup.

const fs   = require('fs');
const path = require('path');
const pool = require('./pool');

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
  const client = await pool.connect();
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
