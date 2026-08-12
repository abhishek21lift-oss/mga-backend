// Migration 135 must never drop an index that backs a constraint.
//
// Audit finding H-04 dropped 17 redundant indexes. Twelve of those pairs were
// a plain index shadowed by a UNIQUE index on the same columns, and in eleven
// of them the UNIQUE index BACKS A CONSTRAINT — a primary key or a unique
// constraint. Postgres does not let you drop such an index in isolation:
// DROP INDEX takes the constraint with it, silently removing the uniqueness
// guarantee the application relies on.
//
// So in every pair there was a right twin and a wrong twin, and the wrong one
// looks equally droppable in a diff. users(email) is the sharp example:
// dropping idx_users_email is correct and harmless, dropping users_email_key
// would let two accounts share an address.
//
// ── Why this test is static and narrow ──────────────────────────────────
//
// The general check — "every foreign key has a covering index, and no two
// indexes are redundant" — cannot be done from the SQL files. The files and
// the database genuinely disagree: ~150 indexes exist in production that no
// migration creates, and seven foreign keys the files declare were never
// created because their CREATE TABLE IF NOT EXISTS hit a table that already
// existed. A static version of that check needs an allowlist encoding the
// drift, which is not a test. It lives in scripts/verify-indexes.js instead,
// where it can ask the database.
//
// What IS a file-level invariant is the naming rule above, and it is exactly
// the mistake with a destructive outcome. That is what this guards.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '135_fk_indexes_and_duplicate_indexes.sql');

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Index names the migration drops. */
function droppedIndexes(sql) {
  const re = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
  return [...stripComments(sql).matchAll(re)].map((m) => m[1].toLowerCase());
}

/** Index names the migration creates. */
function createdIndexes(sql) {
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+ON\b/gi;
  return [...stripComments(sql).matchAll(re)].map((m) => m[1].toLowerCase());
}

describe('migration 135 — index hygiene (audit H-04)', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const dropped = droppedIndexes(sql);
  const created = createdIndexes(sql);

  it('reads the migration, so this cannot pass vacuously', () => {
    expect(created.length).toBe(29);
    expect(dropped.length).toBe(17);
  });

  it('never drops an index whose name marks it as constraint-backed', () => {
    // Postgres names the index behind a unique constraint <table>_<cols>_key
    // and behind a primary key <table>_pkey. Dropping either drops the
    // constraint. Eleven of the 17 pairs had such an index as the SURVIVOR;
    // if one of these names ever appears in a DROP here, the wrong twin was
    // chosen and a uniqueness guarantee is being removed by accident.
    const constraintBacked = dropped.filter((n) => /_key$|_pkey$/.test(n));
    expect(constraintBacked).toEqual([]);
  });

  it('keeps the unique expression index that enforces case-insensitive email', () => {
    // users_email_lower_idx is UNIQUE but backs no constraint, because an
    // expression index cannot — so the _key/_pkey rule above does not protect
    // it. It is nonetheless the twin that must survive: login is
    // `LOWER(u.email) = LOWER($1)`, and without this index two accounts could
    // differ only in case. The plain twin idx_users_email_lower is the one to
    // drop, and this asserts the migration did not confuse them.
    expect(dropped).toContain('idx_users_email_lower');
    expect(dropped).not.toContain('users_email_lower_idx');
  });

  it('does not create and then drop the same index', () => {
    const both = created.filter((n) => dropped.includes(n));
    expect(both).toEqual([]);
  });

  it('is idempotent — every statement is guarded', () => {
    // migrate.js runs each file once, but a restored branch or a manual
    // re-apply must not error on an index that already exists or is gone.
    const body = stripComments(sql);
    const unguardedCreate = [...body.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\s+IF|IF\s+NOT\s+EXISTS)/gi)];
    expect(unguardedCreate).toEqual([]);
    const unguardedDrop = [...body.matchAll(/DROP\s+INDEX\s+(?!(?:CONCURRENTLY\s+)?IF\s+EXISTS)/gi)];
    expect(unguardedDrop).toEqual([]);
  });

  it('cannot use CREATE INDEX CONCURRENTLY, and does not', () => {
    // src/db/migrate.js wraps every migration in BEGIN/COMMIT (see the
    // client.query('BEGIN') around the file read), and CONCURRENTLY is
    // rejected inside a transaction block. A well-meaning "make this
    // non-blocking" edit would break every deploy, so pin the expectation
    // here next to the reason.
    expect(stripComments(sql)).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);

    const runner = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
    expect(runner).toMatch(/client\.query\('BEGIN'\)/);
  });
});
