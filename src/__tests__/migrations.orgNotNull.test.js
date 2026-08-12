// Migration 155 must never be able to abort a deploy, or tighten a shared table.
//
// Audit finding H-5. organization_id was retrofitted NULLABLE onto the tables
// carrying most of the business data (migrations 079-097, 143) and never
// tightened, while every table designed multi-tenant from birth declares it
// NOT NULL. The consequence is silent data loss rather than a leak: a write
// path that fails to stamp the column produces a row belonging to nobody —
// invisible to every tenant's queries, present in the table, reported to the
// caller as success.
//
// Two things about the fix are easy to get wrong later, and both are worse than
// leaving the column nullable, so they are asserted here rather than trusted:
//
//   1. A bare SET NOT NULL against a table holding one orphan aborts the whole
//      migration run — and migrations now run inside the deploy (H-2), so that
//      is a production outage caused by a schema change whose purpose was to
//      surface a data problem. The migration must check first and skip loudly.
//
//   2. The shared/platform tables must stay out of the list. exercises holds
//      890 rows with a NULL organization_id because it is the library every
//      studio draws from; tightening it would require inventing an owner for
//      platform content, and the migration would either fail forever or force
//      someone to assign 890 shared rows to one tenant.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'db', 'migrations', '155_organization_id_not_null.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

/** The table names inside the `targets` array literal. */
function targets() {
  const m = body.match(/targets\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

// Verified against the live database, not assumed. Each holds NULL
// organization_id rows that MEAN "belongs to the platform".
const SHARED_TABLES = [
  'exercises',                 // 890 rows, all NULL — the shared exercise library
  'diet_templates',            // shared templates
  'muscle_volume_landmarks',   // reference data
  'login_events',              // failed attempts with no identified user
  'users',                     // the platform super_admin has no organization
  'workout_plans',             // org-owned and shared template plans coexist
  'storage_objects',
  'user_webauthn_credentials',
];

describe('migration 155 — organization_id NOT NULL', () => {
  it('targets a real list of tables, so this cannot pass vacuously', () => {
    expect(targets().length).toBeGreaterThan(20);
    for (const core of ['pt_clients', 'pt_payments', 'attendance_logs', 'trainers']) {
      expect(targets()).toContain(core);
    }
  });

  it.each(SHARED_TABLES)('never tightens %s, whose NULLs are meaningful', (table) => {
    // Adding one of these to the list would either fail forever, or force
    // 890 shared exercises to be assigned to a single studio.
    expect(targets()).not.toContain(table);
  });

  it('counts NULLs before tightening each table', () => {
    expect(body).toMatch(/SELECT count\(\*\) FROM public\.%I WHERE organization_id IS NULL/);
  });

  it('only tightens when the count is zero', () => {
    expect(body).toMatch(/IF\s+null_count\s*=\s*0\s+THEN/);
    expect(body).toMatch(/ALTER COLUMN organization_id SET NOT NULL/);
  });

  it('WARNS rather than raising an exception when it finds orphans', () => {
    // RAISE EXCEPTION here would abort the migration run and, since H-2, the
    // deploy with it. The orphaned rows are already invisible to every tenant;
    // stopping the release does not make them visible.
    expect(body).toMatch(/RAISE WARNING/);
    expect(body).not.toMatch(/RAISE EXCEPTION/);
  });

  it('names the table and the row count in the warning, so it is actionable', () => {
    const warn = body.match(/RAISE WARNING[\s\S]*?;/)[0];
    expect(warn).toMatch(/%/);
    expect(warn).toMatch(/re-run this migration/i);
  });

  it('skips tables that do not exist in this environment', () => {
    // The schema grew across 154 migrations; not every environment has every
    // table. Same guard style as 101 and 148.
    expect(body).toMatch(/to_regclass\('public\.' \|\| t\) IS NULL/);
  });

  it('is idempotent — an already-NOT NULL column is left alone', () => {
    expect(body).toMatch(/is_nullable = 'YES'/);
  });
});
