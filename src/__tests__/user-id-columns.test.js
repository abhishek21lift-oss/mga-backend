// A column that holds a user id must be TEXT, never UUID.
//
// users.id is TEXT and some accounts carry non-UUID ids — "usr-superadmin-001"
// for seeded platform admins. Declaring a column UUID and then writing
// req.user.id into it does not fail at migration time or in review. It fails
// at runtime, on the first write, with:
//
//   invalid input syntax for type uuid: "usr-superadmin-001"
//
// ── Why this test exists ────────────────────────────────────────────────
//
// This has now happened three times, from one migration:
//
//   099 → subscription_events.actor_id      fixed by 109
//   099 → subscription_payments.recorded_by fixed by 142
//   124 → platform_announcements.created_by fixed by 142
//
// 109 diagnosed the bug correctly and fixed exactly one column, leaving two
// siblings declared the same way in the same migration. The second one
// surfaced as a bare "An internal error occurred" on the super-admin screen
// that approves UPI subscription payments — the one place in the product
// where money changes hands.
//
// So this is the same shape of guard as rls.convention.test.js: read the
// migrations, fail the branch, don't wait for production to find it.
//
// ── Why the check is static ─────────────────────────────────────────────
//
// Querying information_schema would need a live database, which CI does not
// have, and would only catch the mistake after it shipped.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Column names that unambiguously hold a user id.
 *
 * Deliberately a fixed list rather than a pattern like `%_by`: plenty of
 * UUID columns legitimately reference organizations or other UUID-keyed
 * rows, and a check that flags those is a check somebody switches off.
 */
const USER_ID_COLUMNS = new Set([
  'user_id', 'actor_id', 'admin_id',
  'created_by', 'updated_by', 'recorded_by', 'reviewed_by', 'decided_by',
  'approved_by', 'rejected_by', 'granted_by', 'cancelled_by', 'deleted_by',
  'changed_by', 'assigned_by',
]);

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function migrations() {
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, n: parseInt(f.slice(0, 3), 10) }))
    .filter((m) => Number.isFinite(m.n))
    .sort((a, b) => a.n - b.n)
    .map((m) => ({ ...m, sql: fs.readFileSync(path.join(DIR, m.file), 'utf8') }));
}

/**
 * Every user-id column a migration declares as UUID, as "table.column".
 * Covers both CREATE TABLE bodies and ALTER TABLE ... ADD COLUMN.
 */
function uuidUserIdColumnsIn(sql) {
  const body = stripComments(sql);
  const found = [];

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  for (const m of body.matchAll(createRe)) {
    const table = m[1].toLowerCase();
    for (const col of m[2].matchAll(/^\s*["']?([a-z0-9_]+)["']?\s+UUID\b/gim)) {
      const name = col[1].toLowerCase();
      if (USER_ID_COLUMNS.has(name)) found.push(`${table}.${name}`);
    }
  }

  const addRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?\s+UUID\b/gi;
  for (const m of body.matchAll(addRe)) {
    const table = m[1].toLowerCase();
    const name = m[2].toLowerCase();
    if (USER_ID_COLUMNS.has(name)) found.push(`${table}.${name}`);
  }

  return [...new Set(found)];
}

/** Columns a migration widens to TEXT, as "table.column". */
function widenedToTextIn(sql) {
  const body = stripComments(sql);
  const re = /ALTER\s+TABLE\s+(?:public\.)?["']?([a-z0-9_]+)["']?\s+ALTER\s+COLUMN\s+["']?([a-z0-9_]+)["']?\s+(?:SET\s+DATA\s+)?TYPE\s+TEXT/gi;
  return [...new Set([...body.matchAll(re)].map((m) => `${m[1].toLowerCase()}.${m[2].toLowerCase()}`))];
}

describe('user-id columns are TEXT, not UUID', () => {
  const all = migrations();

  it('finds migrations to check, so this cannot pass vacuously', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it('leaves no user-id column declared UUID by the end of the chain', () => {
    // Walk the migrations in order and track the net effect: a column
    // declared UUID and later widened to TEXT is fine — that is what a fix
    // looks like. Only a declaration nothing ever corrects is a bug.
    const outstanding = new Map();

    for (const m of all) {
      for (const col of uuidUserIdColumnsIn(m.sql)) {
        if (!outstanding.has(col)) outstanding.set(col, m.file);
      }
      for (const col of widenedToTextIn(m.sql)) {
        outstanding.delete(col);
      }
    }

    // A failure here means a write of req.user.id into this column throws
    // "invalid input syntax for type uuid" for any account whose id is not
    // UUID-shaped, and the endpoint returns a bare 500. Declare the column
    // TEXT, or widen it:
    //   ALTER TABLE <t> ALTER COLUMN <c> TYPE TEXT USING <c>::TEXT;
    const missing = [...outstanding].map(([col, file]) => `${file} → ${col}`);
    expect(missing).toEqual([]);
  });
});
