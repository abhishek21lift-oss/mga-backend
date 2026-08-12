#!/usr/bin/env node
'use strict';
/**
 * Prove a MY GYM AGENT database can be built from nothing, twice, identically.
 *
 * This is the permanent regression guard for fresh-database bootstrap. The
 * failure it exists to catch is silent: a migration that quietly depends on
 * state only an already-migrated database has. Every deployment to date had
 * that state, so nothing noticed until an empty database was tried and the
 * very first file failed with `42P01 relation "clients" does not exist`.
 *
 * It shells out to `node src/db/migrate.js` rather than importing and calling
 * runMigrations(). That is deliberate: the thing under test is the real
 * migration entry point as a deployment runs it, including its pool setup and
 * fail-fast behaviour. A reimplementation here could pass while the real
 * runner failed, which is the one outcome that would make this test worthless.
 *
 * Requires: PostgreSQL 17, pgvector, and the Supabase roles the migrations
 * grant to. See src/db/migrations/DATABASE-BOOTSTRAP.md.
 *
 * Usage:  ADMIN_URL=postgresql://…/postgres  node scripts/db-bootstrap-verify.js
 */

const { Client } = require('pg');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ADMIN_URL = process.env.ADMIN_URL || process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.error('ADMIN_URL (or DATABASE_URL) must point at a PostgreSQL server.');
  process.exit(2);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIGRATE_JS = path.join(__dirname, '..', 'src', 'db', 'migrate.js');
const EXPECTED_MIGRATIONS = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length;
const FOUNDATION_MARKER = 'foundation/schema-v4.sql';

const DB_A = 'mga_bootstrap_a';
const DB_B = 'mga_bootstrap_b';
const DB_EXISTING = 'mga_bootstrap_existing';

let failures = 0;

/**
 * Everything printed is also written to the GitHub Actions job summary.
 *
 * Not decoration: downloading an Actions job log requires admin rights on the
 * repository, so on a public repo the run's pass/fail is visible to everyone
 * and the reason for it is visible to nobody. The step summary is exposed
 * through the Checks API, so the actual counts — how many migrations applied,
 * whether the two builds hashed identically — can be read without a token.
 */
const transcript = [];
const emit = (line) => { transcript.push(line); console.log(line); };
const ok = (label, detail = '') => emit(`  PASS  ${label}${detail ? '  — ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; emit(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); };
const head = (t) => emit(`\n=== ${t} ===`);

function writeSummary() {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const body = [
    '## Fresh-database bootstrap',
    '',
    failures ? `**${failures} check(s) FAILED**` : '**All checks passed**',
    '',
    '```',
    transcript.join('\n').trim(),
    '```',
    '',
  ].join('\n');
  try { fs.appendFileSync(file, body); } catch { /* summary is best-effort */ }
}
process.on('exit', writeSummary);

/** Same URL, different database name. */
function urlFor(db) {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + db;
  return u.toString();
}

async function connect(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function withAdmin(fn) {
  const c = await connect(ADMIN_URL);
  try { return await fn(c); } finally { await c.end(); }
}

async function recreate(db) {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${db}`);
  });
}

/** Run the real migration entry point against `db`. Returns its stdout. */
function migrate(db) {
  return execFileSync(process.execPath, [MIGRATE_JS], {
    // Pinned, not inherited — see the note in rls-security-verify.js. An
    // inherited MIGRATION_DATABASE_URL comes from .env and points at the
    // real database, which is not what a bootstrap verification should touch.
    env: { ...process.env, DATABASE_URL: urlFor(db), MIGRATION_DATABASE_URL: urlFor(db) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
}

/**
 * A structural fingerprint of the database: everything that should be
 * identical between two builds from the same source, and nothing that
 * legitimately varies (oids, timestamps, row counts).
 */
async function fingerprint(c) {
  const q = async (sql) => (await c.query(sql)).rows.map((r) => Object.values(r).join('')).sort();
  const parts = {
    extensions: await q(`SELECT extname FROM pg_extension ORDER BY 1`),
    tables: await q(`SELECT table_name FROM information_schema.tables
                      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`),
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'')
                        FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`),
    constraints: await q(`SELECT conrelid::regclass::text, conname, contype, pg_get_constraintdef(oid)
                            FROM pg_constraint
                           WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes
                       WHERE schemaname='public' ORDER BY 1,2`),
    sequences: await q(`SELECT sequence_name FROM information_schema.sequences
                         WHERE sequence_schema='public' ORDER BY 1`),
    functions: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid)
                          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                         WHERE n.nspname='public' ORDER BY 1,2`),
    triggers: await q(`SELECT c.relname, t.tgname FROM pg_trigger t
                         JOIN pg_class c ON c.oid=t.tgrelid
                         JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE NOT t.tgisinternal AND n.nspname='public' ORDER BY 1,2`),
    rls: await q(`SELECT c.relname, c.relrowsecurity::text FROM pg_class c
                    JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`),
    policies: await q(`SELECT tablename, policyname, cmd, coalesce(qual,''), coalesce(with_check,'')
                         FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`),
  };
  const counts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length]));
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(Object.entries(parts).map(([k, v]) => [k, v])))
    .digest('hex');
  return { parts, counts, hash };
}

(async () => {
  head('STEP 1 — environment');
  await withAdmin(async (c) => {
    const { rows: [v] } = await c.query('SELECT version() v');
    emit('  ' + v.v.split(',')[0]);
    const major = Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000 | 0;
    major >= 17 ? ok('PostgreSQL >= 17', 'major ' + major) : bad('PostgreSQL >= 17', 'major ' + major);
    const { rows: av } = await c.query(`SELECT default_version FROM pg_available_extensions WHERE name='vector'`);
    if (!av.length) { bad('pgvector available'); console.log('\npgvector is required — stopping.'); process.exit(1); }
    ok('pgvector available', 'v' + av[0].default_version);
  });

  // Supabase grants these; a plain PostgreSQL must be given them or 27
  // migrations fail with 42704 role "anon" does not exist.
  await withAdmin(async (c) => {
    for (const r of ['anon', 'authenticated', 'service_role']) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}')
                     THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$;`);
    }
    ok('Supabase roles present', 'anon, authenticated, service_role');
  });

  head('STEP 2-3 — first replay from empty');
  await recreate(DB_A);
  await withAdmin(async () => {});
  {
    const c = await connect(urlFor(DB_A));
    const { rows: [t] } = await c.query(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
    t.n === 0 ? ok('database starts empty', '0 tables') : bad('database starts empty', t.n + ' tables');
    await c.end();
  }
  migrate(DB_A);

  const a = await (async () => {
    const c = await connect(urlFor(DB_A));
    const applied = (await c.query(`SELECT filename FROM _migrations ORDER BY id`)).rows.map((r) => r.filename);
    const fp = await fingerprint(c);
    await c.end();
    return { applied, fp };
  })();

  const migRows = a.applied.filter((f) => f !== FOUNDATION_MARKER);
  a.applied.includes(FOUNDATION_MARKER) ? ok('foundation recorded') : bad('foundation recorded');
  migRows.length === EXPECTED_MIGRATIONS
    ? ok(`${EXPECTED_MIGRATIONS}/${EXPECTED_MIGRATIONS} migrations applied`)
    : bad('all migrations applied', `${migRows.length}/${EXPECTED_MIGRATIONS}`);
  new Set(a.applied).size === a.applied.length ? ok('no duplicate tracking rows') : bad('no duplicate tracking rows');
  {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const missing = onDisk.filter((f) => !migRows.includes(f));
    missing.length === 0 ? ok('every migration file recorded') : bad('every migration file recorded', missing.slice(0, 5).join(', '));
  }

  head('STEP 4 — pgvector migrations');
  for (const m of ['046_branch_scope_and_pgvector.sql', '116_ai_knowledge_base.sql', '135_fk_indexes_and_duplicate_indexes.sql']) {
    migRows.includes(m) ? ok(m) : bad(m, 'not applied');
  }

  head('STEP 6 — object inventory');
  for (const [k, n] of Object.entries(a.fp.counts)) emit(`  ${k.padEnd(12)} ${n}`);

  head('STEP 7 — pgvector functional test');
  {
    const c = await connect(urlFor(DB_A));
    const { rows: ext } = await c.query(`SELECT extversion FROM pg_extension WHERE extname='vector'`);
    ext.length ? ok('vector extension installed', 'v' + ext[0].extversion) : bad('vector extension installed');
    const { rows: cols } = await c.query(
      `SELECT c.relname, a.attname FROM pg_attribute a
         JOIN pg_class c ON c.oid=a.attrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_type t ON t.oid=a.atttypid
        WHERE n.nspname='public' AND t.typname='vector' AND a.attnum>0 ORDER BY 1,2`);
    cols.length ? ok('vector columns exist', cols.map((r) => r.relname + '.' + r.attname).join(', '))
                : bad('vector columns exist', 'none found');
    const { rows: vidx } = await c.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND (indexdef ILIKE '%USING ivfflat%' OR indexdef ILIKE '%USING hnsw%')`);
    emit(`  vector indexes: ${vidx.length ? vidx.map((r) => r.indexname).join(', ') : '(none declared)'}`);

    // Round-trip through a real vector column: write, read, and order by
    // distance. Uses whichever table actually has one rather than assuming
    // a schema this script does not own.
    if (cols.length) {
      const { relname, attname } = cols[0];
      try {
        const { rows: [d] } = await c.query(
          `SELECT format_type(a.atttypid, a.atttypmod) t FROM pg_attribute a
             JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname=$1 AND a.attname=$2`, [relname, attname]);
        const dim = Number((d.t.match(/\((\d+)\)/) || [])[1] || 3);
        const v1 = '[' + Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)).join(',') + ']';
        const v2 = '[' + Array.from({ length: dim }, (_, i) => (i === 0 ? 0.9 : 0)).join(',') + ']';
        const { rows: [r] } = await c.query(
          `SELECT $1::vector <-> $2::vector AS l2, $1::vector <=> $2::vector AS cosine`, [v1, v2]);
        (Number(r.l2) >= 0) ? ok('vector distance operators work', `l2=${Number(r.l2).toFixed(4)} cosine=${Number(r.cosine).toFixed(4)} dim=${dim}`)
                            : bad('vector distance operators work');
      } catch (e) { bad('vector distance operators work', e.message); }
    }
    await c.end();
  }

  head('STEP 8-9 — second replay and reproducibility');
  await recreate(DB_B);
  migrate(DB_B);
  const b = await (async () => {
    const c = await connect(urlFor(DB_B));
    const applied = (await c.query(`SELECT filename FROM _migrations ORDER BY id`)).rows.map((r) => r.filename);
    const fp = await fingerprint(c);
    await c.end();
    return { applied, fp };
  })();
  b.applied.length === a.applied.length
    ? ok('second replay applied the same count', String(b.applied.length))
    : bad('second replay applied the same count', `${b.applied.length} vs ${a.applied.length}`);

  if (a.fp.hash === b.fp.hash) {
    ok('schemas identical', 'sha256 ' + a.fp.hash.slice(0, 16));
  } else {
    bad('schemas identical');
    for (const k of Object.keys(a.fp.parts)) {
      const A = new Set(a.fp.parts[k]), B = new Set(b.fp.parts[k]);
      const onlyA = [...A].filter((x) => !B.has(x)), onlyB = [...B].filter((x) => !A.has(x));
      if (onlyA.length || onlyB.length) {
        console.log(`    ${k}: only in A=${onlyA.length}, only in B=${onlyB.length}`);
        [...onlyA.slice(0, 3), ...onlyB.slice(0, 3)].forEach((x) => console.log('      ' + String(x).slice(0, 120)));
      }
    }
  }

  head('STEP 10 — rerun safety');
  {
    const out = migrate(DB_A);
    const reapplied = (out.match(/→ Applying/g) || []).length;
    reapplied === 0 ? ok('nothing re-applied on rerun') : bad('nothing re-applied on rerun', reapplied + ' files ran again');
    const c = await connect(urlFor(DB_A));
    const fp2 = await fingerprint(c);
    const rows = (await c.query('SELECT count(*)::int n FROM _migrations')).rows[0].n;
    await c.end();
    fp2.hash === a.fp.hash ? ok('schema unchanged by rerun') : bad('schema unchanged by rerun');
    rows === a.applied.length ? ok('tracking rows unchanged', String(rows)) : bad('tracking rows unchanged');
  }

  head('STEP 11 — existing-data safety');
  {
    await recreate(DB_EXISTING);
    migrate(DB_EXISTING);
    const c = await connect(urlFor(DB_EXISTING));
    // Seed through whatever the schema actually offers, then re-migrate.
    await c.query(`INSERT INTO organizations (name, slug, status) VALUES ('619 Fitness Studio','tenant-a-phase4','active')
                   ON CONFLICT (slug) DO NOTHING`);
    await c.query(`INSERT INTO branches (id,name,code) VALUES ('ph4','Phase4 Branch','PH4') ON CONFLICT (code) DO NOTHING`);
    await c.query(`INSERT INTO clients (name, mobile) VALUES ('Phase4 Member','9999900004')`);
    await c.query(`UPDATE system_settings SET value='Edited By Operator' WHERE key='gym_name'`);
    await c.end();

    migrate(DB_EXISTING);

    const d = await connect(urlFor(DB_EXISTING));
    const org = (await d.query(`SELECT name FROM organizations WHERE slug='tenant-a-phase4'`)).rows;
    const br = (await d.query(`SELECT name FROM branches WHERE code='PH4'`)).rows;
    const cl = (await d.query(`SELECT name FROM clients WHERE mobile='9999900004'`)).rows;
    const st = (await d.query(`SELECT value FROM system_settings WHERE key='gym_name'`)).rows;
    const dupOrg = (await d.query(`SELECT count(*)::int n FROM organizations WHERE slug='tenant-a-phase4'`)).rows[0].n;
    await d.end();
    org.length ? ok('organization preserved', org[0].name) : bad('organization preserved');
    br.length ? ok('branch preserved') : bad('branch preserved');
    cl.length ? ok('client preserved') : bad('client preserved');
    st[0] && st[0].value === 'Edited By Operator'
      ? ok('edited setting not overwritten by seed') : bad('edited setting not overwritten', st[0] && st[0].value);
    dupOrg === 1 ? ok('no duplicate rows created') : bad('no duplicate rows created', String(dupOrg));
  }

  head('STEP 13 — tenant scoping snapshot (report only)');
  {
    const c = await connect(urlFor(DB_A));
    const { rows: [s] } = await c.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
        (SELECT count(DISTINCT table_name)::int FROM information_schema.columns
          WHERE table_schema='public' AND column_name='organization_id') AS org_scoped,
        (SELECT count(DISTINCT table_name)::int FROM information_schema.columns
          WHERE table_schema='public' AND column_name='branch_id') AS branch_scoped,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_enabled,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname='public') AS policies`);
    emit(`  tables ${s.tables} | organization_id ${s.org_scoped} | branch_id ${s.branch_scoped} | RLS-enabled ${s.rls_enabled} | policies ${s.policies}`);
    const { rows: unscoped } = await c.query(`
      SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
         AND t.table_name <> '_migrations'
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                          WHERE c.table_schema='public' AND c.table_name=t.table_name
                            AND c.column_name IN ('organization_id'))
       ORDER BY 1`);
    emit(`  without organization_id (${unscoped.length}): ${unscoped.map((r) => r.table_name).join(' ')}`);
    await c.end();
  }

  head('RESULT');
  if (failures) { console.log(`  ${failures} check(s) FAILED`); process.exit(1); }
  console.log('  all checks passed');
  process.exit(0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', e.message);
  if (e.stdout) console.error(String(e.stdout).slice(-4000));
  if (e.stderr) console.error(String(e.stderr).slice(-4000));
  process.exit(1);
});
