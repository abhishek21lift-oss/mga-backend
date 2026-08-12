// A migration must not touch a table that an earlier migration dropped.
//
// Audit finding C-5, and the second time this exact bug has shipped.
//
// 030b creates `staff`/`staff_targets`, 064_drop_staff_module.sql drops them,
// and no tracked migration creates them again — the `staff.sql` recorded in
// `_migrations` on the live database is not a file in this repo, so the
// recreation happened out of band. 148_staff_tables_rls.sql then ran
// `ALTER TABLE staff ENABLE ROW LEVEL SECURITY` with no guard.
//
// On the live database that worked, because the out-of-band table was there.
// On a database built from this repo it raised
//
//     ERROR: 42P01: relation "staff" does not exist
//
// (reproduced against a real Postgres, not assumed) and migrate.js stops on the
// first failure — so migrations 149-154 never applied either. Standing up a new
// environment produced a database silently six migrations behind, and the error
// pointed at RLS rather than at the missing table.
//
// 101_perf_fk_indexes_and_rls_initplan.sql had already hit this with
// `gym_settings` and fixed it with a to_regclass guard. Fixing the instance
// twice without catching the class is how it arrives a third time.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

/** Migration files in the order migrate.js applies them (readdir + sort). */
function migrations() {
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      sql: fs.readFileSync(path.join(DIR, file), 'utf8').replace(/--[^\n]*/g, ' '),
    }));
}

const TABLE = '([a-z0-9_]+)';

/**
 * Net effect of one migration on each table it mentions: 'created' or 'dropped'.
 *
 * Position matters — 033_schema_fixes.sql both drops and recreates `staff`, and
 * reading it as a drop would report a table that demonstrably exists after it.
 * Whichever statement appears last is the one that wins.
 */
function netEffect(sql) {
  const effect = new Map();
  const record = (name, kind, at) => {
    const prev = effect.get(name);
    if (!prev || at > prev.at) effect.set(name, { kind, at });
  };
  for (const m of sql.matchAll(new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?["']?${TABLE}["']?`, 'gi'))) {
    record(m[1].toLowerCase(), 'dropped', m.index);
  }
  for (const m of sql.matchAll(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?["']?${TABLE}["']?`, 'gi'))) {
    record(m[1].toLowerCase(), 'created', m.index);
  }
  return effect;
}

/** Statements that hard-fail when the table is absent (IF EXISTS forms do not). */
function unguardedReferences(sql, table) {
  const hits = [];
  const patterns = [
    [`ALTER\\s+TABLE\\s+(?!IF\\s+EXISTS)(?:public\\.)?["']?${table}["']?\\b`, 'ALTER TABLE'],
    [`CREATE\\s+POLICY\\s+[a-z0-9_]+\\s+ON\\s+(?:public\\.)?["']?${table}["']?\\b`, 'CREATE POLICY'],
    [`DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?[a-z0-9_]+\\s+ON\\s+(?:public\\.)?["']?${table}["']?\\b`, 'DROP POLICY'],
    [`REVOKE\\s+[\\s\\S]{0,40}?\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?["']?${table}["']?\\b`, 'REVOKE'],
    [`GRANT\\s+[\\s\\S]{0,40}?\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?["']?${table}["']?\\b`, 'GRANT'],
    [`CREATE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?[a-z0-9_]+\\s+ON\\s+(?:public\\.)?["']?${table}["']?\\b`, 'CREATE INDEX'],
  ];
  for (const [re, label] of patterns) {
    if (new RegExp(re, 'i').test(sql)) hits.push(label);
  }
  return hits;
}

/** Does the migration guard this table's existence before touching it? */
function guards(sql, table) {
  return new RegExp(`to_regclass\\(\\s*['"](?:public\\.)?${table}['"]\\s*\\)`, 'i').test(sql)
    || /FROM pg_class/i.test(sql); // catalogue-driven sweeps discover tables at runtime
}

describe('migrations survive a fresh database', () => {
  const all = migrations();

  it('reads the migration set, so this cannot pass vacuously', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('never touches a table an earlier migration dropped without guarding it', () => {
    // Replay the migrations in apply order, tracking which tables exist.
    const dropped = new Map(); // table -> file that dropped it
    const offenders = [];

    for (const m of all) {
      // Check references BEFORE applying this file's own net effect, so a file
      // that recreates a table and then alters it is not flagged.
      for (const [table, byFile] of dropped) {
        const refs = unguardedReferences(m.sql, table);
        if (refs.length && !guards(m.sql, table)) {
          offenders.push(`${m.file} → ${refs.join('/')} on "${table}" (dropped by ${byFile})`);
        }
      }
      for (const [table, { kind }] of netEffect(m.sql)) {
        if (kind === 'dropped') dropped.set(table, m.file);
        else dropped.delete(table);
      }
    }

    // A failure here means `npm run migrate` against a NEW database aborts at
    // the named file, and every migration after it silently never applies.
    // Wrap the statement in an existence guard, matching 101 and 148:
    //
    //   DO $$ BEGIN
    //     IF to_regclass('public.<table>') IS NOT NULL THEN
    //       ALTER TABLE <table> ...;
    //     END IF;
    //   END $$;
    expect(offenders).toEqual([]);
  });

  it('keeps 148 guarded specifically — the case that shipped broken', () => {
    // Named explicitly so a future edit that strips the guard fails with a test
    // that says why, rather than only through the generic check above.
    const sql = fs.readFileSync(path.join(DIR, '148_staff_tables_rls.sql'), 'utf8')
      .replace(/--[^\n]*/g, ' ');
    expect(sql).toMatch(/to_regclass\(\s*'public\.staff'\s*\)/);
    expect(sql).toMatch(/to_regclass\(\s*'public\.staff_targets'\s*\)/);

    // Every ALTER must sit AFTER the guard that protects it. Checking position
    // rather than indentation, since indentation is not what makes it safe.
    for (const table of ['staff', 'staff_targets']) {
      const guardAt = sql.search(new RegExp(`to_regclass\\(\\s*'public\\.${table}'\\s*\\)`));
      const alterAt = sql.search(new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`));
      expect(guardAt).toBeGreaterThan(-1);
      expect(alterAt).toBeGreaterThan(guardAt);
    }
  });
});
