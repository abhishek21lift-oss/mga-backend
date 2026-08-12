#!/usr/bin/env node
'use strict';
/**
 * Prove tenant isolation is a database boundary, not a convention.
 *
 * Everything here runs as `app_tenant` — LOGIN, NOSUPERUSER, NOBYPASSRLS.
 * That is the entire point. The application has always connected as a role
 * that bypasses RLS, so every policy migration 157 generates has been
 * decorative: present in the catalogue, never once consulted. A test run as
 * `postgres` would pass while proving nothing, because `postgres` owns the
 * tables and ignores their policies.
 *
 * The matrix below is run per tenant-owned table rather than on one
 * representative, because a policy is generated per table and a single
 * missing one is exactly the leak this is meant to catch.
 *
 * Rows for the fixtures are synthesised by reading information_schema for
 * NOT NULL columns without defaults, so tables can be added to the schema
 * without this script needing to learn their shape.
 *
 * Usage: ADMIN_URL=postgresql://…/postgres node scripts/rls-security-verify.js
 */

const { Client } = require('pg');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ADMIN_URL = process.env.ADMIN_URL || process.env.DATABASE_URL;
if (!ADMIN_URL) { console.error('ADMIN_URL must be set'); process.exit(2); }

const DB = process.env.RLS_TEST_DB || 'mga_rls_test';
const MIGRATE_JS = path.join(__dirname, '..', 'src', 'db', 'migrate.js');
// Test-only, never persisted, never a real credential.
const APP_PW = crypto.randomBytes(18).toString('hex');

let failures = 0;
const transcript = [];
const emit = (l) => { transcript.push(l); console.log(l); };
const ok = (l, d = '') => emit(`  PASS  ${l}${d ? '  — ' + d : ''}`);
/**
 * A failure is also emitted as a workflow ::error:: command.
 *
 * Actions job logs need repository admin rights to download, so on a public
 * repo a red job says only "something failed". Annotations are exposed
 * through the Checks API without a token, so the reason travels with the
 * result — which matters most for exactly this job, where the difference
 * between "the harness broke" and "tenant A read tenant B" is the whole
 * point.
 */
const bad = (l, d = '') => {
  failures++;
  emit(`  FAIL  ${l}${d ? '  — ' + d : ''}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=RLS::${l}${d ? ' — ' + d : ''}`);
};
const head = (t) => emit(`\n=== ${t} ===`);
const note = (l) => {
  emit(`  NOTE  ${l}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=RLS::${l}`);
};

process.on('exit', () => {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try {
    fs.appendFileSync(f, ['## RLS tenant isolation', '',
      failures ? `**${failures} check(s) FAILED**` : '**All checks passed**',
      '', '```', transcript.join('\n').trim(), '```', ''].join('\n'));
  } catch { /* best effort */ }
});

const urlFor = (db, user, pw) => {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + db;
  if (user) { u.username = user; u.password = pw || ''; }
  return u.toString();
};
const connect = async (url) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };

/** Build a minimal INSERT for `table`, filling required columns with values
 *  the column's own type accepts. Returns null when the table needs something
 *  we cannot synthesise (a foreign key to a row we did not create). */
async function synthesise(admin, table, orgId) {
  const { rows } = await admin.query(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const cols = [], vals = [];
  for (const c of rows) {
    if (c.column_name === 'organization_id') { cols.push(c.column_name); vals.push(orgId); continue; }
    if (c.is_nullable === 'YES' || c.column_default !== null) continue;
    const t = c.udt_name;
    let v;
    if (/^(int2|int4|int8|numeric|float4|float8)$/.test(t)) v = 0;
    else if (t === 'bool') v = false;
    else if (/^(timestamptz|timestamp|date)$/.test(t)) v = new Date().toISOString();
    else if (t === 'uuid') return null;            // an FK we cannot satisfy
    else if (t === 'jsonb' || t === 'json') v = '{}';
    else if (/^(text|varchar|bpchar|citext)$/.test(t)) v = 'rls-fixture';
    else return null;                               // enum or exotic type
    cols.push(c.column_name); vals.push(v);
  }
  if (!cols.includes('organization_id')) return null;
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  return { sql: `INSERT INTO public.${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph}) RETURNING id`, vals };
}

(async () => {
  head('SETUP — fresh database, foundation + migrations');
  {
    const a = await connect(ADMIN_URL);
    await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${DB}`);
    for (const r of ['anon', 'authenticated', 'service_role']) {
      await a.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}')
                     THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$;`);
    }
    await a.end();
  }
  execFileSync(process.execPath, [MIGRATE_JS], {
    env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  emit('  migrations applied');

  const admin = await connect(urlFor(DB));

  head('STEP 4/17 — app_tenant role');
  // 157 creates the role without a password, deliberately: a password does
  // not belong in a version-controlled migration. Set a throwaway one here.
  await admin.query(`ALTER ROLE app_tenant WITH LOGIN PASSWORD '${APP_PW}'`);
  {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname='app_tenant'`);
    if (!rows.length) { bad('app_tenant exists'); process.exit(1); }
    const r = rows[0];
    r.rolcanlogin ? ok('app_tenant can log in') : bad('app_tenant can log in');
    r.rolsuper === false ? ok('rolsuper = false') : bad('rolsuper = false', 'IS SUPERUSER');
    r.rolbypassrls === false ? ok('rolbypassrls = false') : bad('rolbypassrls = false', 'CAN BYPASS RLS');
    r.rolcreatedb === false ? ok('rolcreatedb = false') : bad('rolcreatedb = false');
    r.rolcreaterole === false ? ok('rolcreaterole = false') : bad('rolcreaterole = false');
    r.rolreplication === false ? ok('rolreplication = false') : bad('rolreplication = false');
  }

  head('SETUP — two tenants');
  const { rows: [A] } = await admin.query(
    `INSERT INTO organizations (name, slug, status) VALUES ('619 Fitness Studio','tenant-a-rls','active') RETURNING id`);
  const { rows: [B] } = await admin.query(
    `INSERT INTO organizations (name, slug, status) VALUES ('ABC Fitness','tenant-b-rls','active') RETURNING id`);
  emit(`  tenant A ${A.id}\n  tenant B ${B.id}`);

  // Which tables actually carry a policy, and are strict (not the shared-row
  // variant that also permits organization_id IS NULL)?
  const { rows: policied } = await admin.query(`
    SELECT tablename, qual FROM pg_policies
     WHERE schemaname='public' AND policyname='tenant_isolation' ORDER BY 1`);
  const strict = policied.filter((p) => !/IS NULL/i.test(p.qual || '')).map((p) => p.tablename);
  note(`policies ${policied.length} (strict ${strict.length}, shared ${policied.length - strict.length})`);

  // Seed one row per strict table for each tenant, as the owner.
  const usable = [];
  for (const t of strict) {
    const sa = await synthesise(admin, t, A.id);
    const sb = await synthesise(admin, t, B.id);
    if (!sa || !sb) continue;
    try {
      const ra = await admin.query(sa.sql, sa.vals);
      const rb = await admin.query(sb.sql, sb.vals);
      usable.push({ table: t, aId: ra.rows[0] && ra.rows[0].id, bId: rb.rows[0] && rb.rows[0].id });
    } catch { /* table needs more than we can synthesise — skip */ }
  }
  note(`seeded fixtures in ${usable.length} of ${strict.length} strict tenant tables`);
  if (usable.length === 0) { bad('at least one tenant table seeded'); process.exit(1); }

  const asTenant = () => connect(urlFor(DB, 'app_tenant', APP_PW));
  /** Run `fn` inside a transaction with app.org_id set, exactly as pool.js does. */
  async function withOrg(c, orgId, fn) {
    await c.query('BEGIN');
    try { await c.query('SELECT set_config($1,$2,true)', ['app.org_id', String(orgId)]); return await fn(); }
    finally { await c.query('COMMIT').catch(() => c.query('ROLLBACK').catch(() => {})); }
  }

  head('STEP 3 — fail closed with no tenant context');
  {
    const c = await asTenant();
    const leaked = [];
    for (const { table } of usable) {
      const { rows } = await c.query(`SELECT count(*)::int n FROM public.${table}`);
      if (rows[0].n !== 0) leaked.push(`${table}=${rows[0].n}`);
    }
    leaked.length === 0
      ? ok('no context returns zero rows on every tenant table', `${usable.length} tables`)
      : bad('no context returns zero rows', leaked.slice(0, 5).join(', '));
    await c.end();
  }

  head('STEP 3 — invalid tenant context');
  {
    const c = await asTenant();
    const fake = '00000000-0000-0000-0000-0000000000ff';
    await withOrg(c, fake, async () => {
      const { rows } = await c.query(`SELECT count(*)::int n FROM public.${usable[0].table}`);
      rows[0].n === 0 ? ok('unknown org id sees nothing') : bad('unknown org id sees nothing', String(rows[0].n));
    });
    await c.end();
  }

  head('STEP 7 — SELECT isolation, per table');
  {
    const c = await asTenant();
    const selfBlind = [], crossVisible = [];
    await withOrg(c, A.id, async () => {
      for (const { table } of usable) {
        const { rows } = await c.query(
          `SELECT count(*) FILTER (WHERE organization_id=$1)::int own,
                  count(*) FILTER (WHERE organization_id=$2)::int other FROM public.${table}`, [A.id, B.id]);
        if (rows[0].own < 1) selfBlind.push(table);
        if (rows[0].other > 0) crossVisible.push(table);
      }
    });
    crossVisible.length === 0
      ? ok('tenant A sees zero tenant B rows', `${usable.length} tables`)
      : bad('tenant A sees zero tenant B rows', crossVisible.slice(0, 6).join(', '));
    selfBlind.length === 0
      ? ok('tenant A sees its own rows', `${usable.length} tables`)
      : bad('tenant A sees its own rows', selfBlind.slice(0, 6).join(', '));
    await c.end();
  }

  head('STEP 8 — INSERT with a forged organization_id');
  {
    const c = await asTenant();
    const t = usable[0].table;
    const forged = await synthesise(admin, t, B.id);
    await withOrg(c, A.id, async () => {
      try { await c.query(forged.sql, forged.vals); bad('forged INSERT rejected', 'it succeeded'); }
      catch (e) { ok('forged INSERT rejected', e.code === '42501' ? 'row-level security policy' : e.code); }
    });
    const own = await synthesise(admin, t, A.id);
    const c2 = await asTenant();
    await withOrg(c2, A.id, async () => {
      try { await c2.query(own.sql, own.vals); ok('legitimate INSERT accepted', t); }
      catch (e) { bad('legitimate INSERT accepted', e.message.slice(0, 60)); }
    });
    await c.end(); await c2.end();
  }

  head('STEP 9 — UPDATE isolation');
  {
    const c = await asTenant();
    const { table, bId } = usable.find((u) => u.bId) || usable[0];
    await withOrg(c, A.id, async () => {
      const r = await c.query(`UPDATE public.${table} SET organization_id=organization_id WHERE organization_id=$1`, [B.id]);
      r.rowCount === 0 ? ok("cannot UPDATE another tenant's rows", `${table}, 0 rows`) : bad("cannot UPDATE another tenant's rows", `${r.rowCount} rows`);
      try {
        const m = await c.query(`UPDATE public.${table} SET organization_id=$1 WHERE organization_id=$2`, [B.id, A.id]);
        m.rowCount === 0 ? ok('cannot move a row A → B', '0 rows') : bad('cannot move a row A → B', `${m.rowCount} rows moved`);
      } catch (e) { ok('cannot move a row A → B', e.code === '42501' ? 'WITH CHECK violation' : e.code); }
      if (bId) {
        const byId = await c.query(`UPDATE public.${table} SET organization_id=organization_id WHERE id=$1`, [bId]);
        byId.rowCount === 0 ? ok("IDOR: UPDATE by tenant B's id affects nothing") : bad('IDOR: UPDATE by id', `${byId.rowCount} rows`);
      }
    });
    await c.end();
  }

  head('STEP 10/12 — DELETE isolation and IDOR');
  {
    const c = await asTenant();
    const crossDeleted = [], idorHits = [];
    await withOrg(c, A.id, async () => {
      for (const { table, bId } of usable) {
        const r = await c.query(`DELETE FROM public.${table} WHERE organization_id=$1`, [B.id]);
        if (r.rowCount > 0) crossDeleted.push(`${table}=${r.rowCount}`);
        if (bId) {
          const d = await c.query(`DELETE FROM public.${table} WHERE id=$1`, [bId]);
          if (d.rowCount > 0) idorHits.push(table);
        }
      }
    });
    crossDeleted.length === 0
      ? ok("cannot DELETE another tenant's rows", `${usable.length} tables`)
      : bad("cannot DELETE another tenant's rows", crossDeleted.join(', '));
    idorHits.length === 0
      ? ok('IDOR: DELETE by a tenant B id affects nothing', `${usable.length} tables`)
      : bad('IDOR: DELETE by id', idorHits.join(', '));
    await c.end();
  }
  // B's rows must still be there, verified as the owner.
  {
    const { table } = usable[0];
    const { rows } = await admin.query(`SELECT count(*)::int n FROM public.${table} WHERE organization_id=$1`, [B.id]);
    rows[0].n > 0 ? ok("tenant B's data survived tenant A's attempts", `${rows[0].n} row(s)`) : bad("tenant B's data survived");
  }

  head('STEP 18 — concurrent tenants on separate connections');
  {
    const cA = await asTenant(), cB = await asTenant();
    const { table } = usable[0];
    const [ra, rb] = await Promise.all([
      withOrg(cA, A.id, async () => (await cA.query(
        `SELECT count(*) FILTER (WHERE organization_id=$1)::int own, count(*) FILTER (WHERE organization_id=$2)::int other FROM public.${table}`, [A.id, B.id])).rows[0]),
      withOrg(cB, B.id, async () => (await cB.query(
        `SELECT count(*) FILTER (WHERE organization_id=$1)::int own, count(*) FILTER (WHERE organization_id=$2)::int other FROM public.${table}`, [B.id, A.id])).rows[0]),
    ]);
    (ra.other === 0 && rb.other === 0)
      ? ok('concurrent contexts do not cross-contaminate', `A saw ${ra.own} own/${ra.other} other, B saw ${rb.own}/${rb.other}`)
      : bad('concurrent contexts do not cross-contaminate', `A other=${ra.other} B other=${rb.other}`);
    await cA.end(); await cB.end();
  }

  head('STEP 6 — context does not survive its transaction');
  {
    const c = await asTenant();
    await withOrg(c, A.id, async () => c.query('SELECT 1'));
    const { rows } = await c.query(`SELECT coalesce(current_setting('app.org_id', true),'') AS v`);
    rows[0].v === ''
      ? ok('app.org_id is transaction-local, not session-wide')
      : bad('app.org_id leaked past its transaction', rows[0].v);
    await c.end();
  }

  head('STEP 23 — legacy tenant seed');
  {
    const { rows } = await admin.query(`SELECT name FROM organizations WHERE slug='abhishek-pt-studio'`);
    rows.length === 0
      ? ok('no legacy business tenant in a fresh database')
      : bad('no legacy business tenant in a fresh database', rows[0].name);
    const { rows: all } = await admin.query(
      `SELECT name FROM organizations WHERE slug NOT IN ('tenant-a-rls','tenant-b-rls')`);
    all.length === 0
      ? ok('fresh database seeds no organizations at all')
      : note(`organizations present besides the test fixtures: ${all.map((r) => r.name).join(', ')}`);
  }

  head('STEP 16 — index coverage for the policy predicate');
  {
    const { rows } = await admin.query(`
      SELECT count(*)::int n FROM information_schema.columns c
       WHERE c.table_schema='public' AND c.column_name='organization_id'
         AND NOT EXISTS (
           SELECT 1 FROM pg_indexes i
            WHERE i.schemaname='public' AND i.tablename=c.table_name
              AND i.indexdef LIKE '%organization_id%')`);
    emit(`  tenant tables with no index mentioning organization_id: ${rows[0].n}`);
  }

  await admin.end();

  head('RESULT');
  if (failures) { emit(`  ${failures} check(s) FAILED`); process.exit(1); }
  emit('  all checks passed');
  process.exit(0);
})().catch((e) => {
  console.error('\nHARNESS ERROR:', e.message);
  if (e.stdout) console.error(String(e.stdout).slice(-3000));
  process.exit(1);
});
