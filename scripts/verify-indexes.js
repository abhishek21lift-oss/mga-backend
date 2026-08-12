#!/usr/bin/env node
'use strict';
// Check the database's index hygiene against the two defects audit H-04 fixed.
//
//   npm run verify:indexes
//
// ── Why this is a script and not a Jest test ─────────────────────────────
//
// The obvious guard for "every foreign key has a covering index" is a static
// test that parses src/db/schema.sql and src/db/migrations/*.sql. I wrote that
// parser first, and it was the wrong instrument. The SQL files are not the
// source of truth for this schema:
//
//   • 543 non-constraint indexes exist in the database; 389 are named by a
//     file. The rest — idx_exercises_created_by, idx_workout_ex_exercise,
//     idx_trials_trainer_id and ~150 more — were created by hand against
//     production and appear in no migration. A database rebuilt from the
//     files would not have them.
//   • Seven foreign keys the files DECLARE do not exist in the database at
//     all: audit_log.changed_by, holds_freezes.created_by,
//     holds_freezes.subscription_id, invoices.created_by,
//     leave_requests.approved_by, member_memberships.subscription_id and
//     pt_sessions.created_by. Each is a `CREATE TABLE IF NOT EXISTS` whose
//     table already existed in an older shape, so the REFERENCES clause was
//     silently skipped. All seven tables are empty, so nothing is corrupt —
//     but the constraint the file promises is not being enforced.
//
// A static test therefore disagrees with the database in both directions, and
// would need a ~19-entry allowlist that encodes the drift instead of catching
// bugs. A test that has to be taught to ignore reality is worse than no test.
//
// So this asks the database, which is the thing that actually knows. It needs
// DATABASE_URL and cannot run in CI, which is the same reason verify:smtp and
// verify:embeddings are scripts.
//
// Exits non-zero if any check fails, so a deploy hook can gate on it.

require('dotenv').config();

const pool = require('../src/db/pool');

/** Foreign keys whose referencing columns are not the leading columns of any index. */
const UNINDEXED_FKS = `
  SELECT c.conrelid::regclass::text AS tbl,
         c.conname,
         (SELECT string_agg(a.attname, ', ' ORDER BY x.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS x(att, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.att) AS cols
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid
          -- indkey is 0-based; slice its leading columns and compare to conkey.
          AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey::int2[]
     )
   ORDER BY 1, 3`;

/**
 * Indexes with an identical shape on the same table.
 *
 * Grouped on the definition AFTER the table name — method, key list,
 * collation, opclass and any partial predicate — but deliberately NOT on
 * uniqueness, because a plain index sitting behind a UNIQUE index over the
 * same columns is just as redundant: the unique btree answers every lookup
 * the plain one does. Supabase's own advisor groups on uniqueness and so
 * reported 5 of these where there were 17.
 */
const DUPLICATE_INDEXES = `
  WITH ix AS (
    SELECT i.indexrelid::regclass::text AS idx,
           i.indrelid::regclass::text   AS tbl,
           regexp_replace(pg_get_indexdef(i.indexrelid),
                          '^CREATE (UNIQUE )?INDEX \\S+ ON \\S+ ', '') AS shape,
           i.indisunique AS uniq,
           EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS backs_constraint
      FROM pg_index i
      JOIN pg_class ic     ON ic.oid = i.indexrelid
      JOIN pg_namespace n  ON n.oid = ic.relnamespace
     WHERE n.nspname = 'public'
  )
  SELECT tbl, shape,
         string_agg(idx
                    || CASE WHEN uniq THEN ' [UNIQUE]' ELSE '' END
                    || CASE WHEN backs_constraint THEN ' [backs a constraint — do not drop]' ELSE '' END,
                    '  |  ' ORDER BY backs_constraint DESC, uniq DESC, idx) AS indexes
    FROM ix
   GROUP BY tbl, shape
  HAVING count(*) > 1
   ORDER BY tbl`;

/**
 * Foreign keys the SQL files declare that the database does not have.
 *
 * Reported but NOT fatal. This is pre-existing drift on seven empty legacy
 * tables, not something a deploy introduced, and adding the constraints is a
 * separate decision with its own risk. It is here so the number is visible
 * rather than folklore — if it ever grows, a `CREATE TABLE IF NOT EXISTS`
 * silently skipped a constraint on a table that already existed.
 */
const DECLARED_BUT_ABSENT = [
  ['audit_log', 'changed_by'],
  ['holds_freezes', 'created_by'],
  ['holds_freezes', 'subscription_id'],
  ['invoices', 'created_by'],
  ['leave_requests', 'approved_by'],
  ['member_memberships', 'subscription_id'],
  ['pt_sessions', 'created_by'],
];

function ok(label, pass, detail) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return pass;
}

async function main() {
  let allGood = true;

  console.log('\n1. Covering indexes for foreign keys');
  const { rows: unindexed } = await pool.query(UNINDEXED_FKS);
  allGood = ok('every foreign key has a covering index',
    unindexed.length === 0,
    unindexed.length ? `${unindexed.length} without one` : 'none missing') && allGood;
  for (const r of unindexed) {
    console.log(`        ${r.tbl} (${r.cols})   ${r.conname}`);
    console.log(`          fix: CREATE INDEX CONCURRENTLY idx_${r.tbl.replace(/^public\./, '')}_${r.cols.split(',')[0].trim()} ON ${r.tbl} (${r.cols});`);
  }
  if (unindexed.length) {
    console.log('\n     Every parent DELETE or key UPDATE across one of these scans the');
    console.log('     whole child table to prove no row still references the old key.');
  }

  console.log('\n2. Redundant indexes');
  const { rows: dupes } = await pool.query(DUPLICATE_INDEXES);
  allGood = ok('no two indexes share a shape on the same table',
    dupes.length === 0,
    dupes.length ? `${dupes.length} redundant pair(s)` : 'none') && allGood;
  for (const r of dupes) {
    console.log(`        ${r.tbl} ${r.shape}`);
    console.log(`          ${r.indexes}`);
  }
  if (dupes.length) {
    console.log('\n     Drop the twin that does NOT back a constraint — dropping a');
    console.log('     constraint-backed index drops the primary key or unique');
    console.log('     constraint with it. Check for a [UNIQUE] marker before choosing:');
    console.log('     an expression index like users_email_lower_idx can be unique');
    console.log('     while backing no constraint, and is the one that must survive.');
  }

  console.log('\n3. Schema drift (informational — does not fail this script)');
  let absent = 0;
  for (const [tbl, col] of DECLARED_BUT_ABSENT) {
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint k
          WHERE k.conrelid = to_regclass('public.' || $1) AND k.contype = 'f'
            AND $2 = ANY (SELECT a.attname FROM pg_attribute a
                           WHERE a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey))
       ) AS present`, [tbl, col]);
    if (!rows[0].present) absent++;
  }
  console.log(`  ${absent === DECLARED_BUT_ABSENT.length ? 'NOTE' : 'DIFF'}  ` +
    `${absent}/${DECLARED_BUT_ABSENT.length} known-absent foreign keys still absent`);
  if (absent !== DECLARED_BUT_ABSENT.length) {
    console.log('        The list in this script no longer matches the database.');
    console.log('        Someone added (or dropped) one of them — update the list.');
  }

  console.log(allGood
    ? '\nIndex hygiene is clean.\n'
    : '\nSomething above failed — see the lines marked FAIL.\n');
  return allGood;
}

main()
  .then(async (good) => { await pool.end(); process.exit(good ? 0 : 1); })
  .catch(async (err) => {
    console.error('\nverify:indexes could not run:', err.message);
    if (/DATABASE_URL|ENOTFOUND|ECONNREFUSED|timeout/i.test(err.message)) {
      console.error('This needs a reachable DATABASE_URL — run it on the deploy.');
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
