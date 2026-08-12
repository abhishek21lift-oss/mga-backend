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

/**
 * Run a statement that is *expected* to be refused, without losing the
 * transaction.
 *
 * A policy violation raises, and PostgreSQL then aborts the whole
 * transaction: every later statement returns 25P02 until rollback. That is
 * precisely the shape of this suite — most assertions here are "this must be
 * denied" — so a plain try/catch passes the first denial and then fails
 * everything after it with a harness error rather than a result. Wrapping
 * each attempt in a savepoint keeps the surrounding transaction, and its
 * app.org_id, alive across an expected refusal.
 *
 * Returns { denied, rowCount, code }.
 */
async function attempt(c, sql, params = []) {
  const sp = 'sp_' + crypto.randomBytes(4).toString('hex');
  await c.query(`SAVEPOINT ${sp}`);
  try {
    const r = await c.query(sql, params);
    await c.query(`RELEASE SAVEPOINT ${sp}`);
    return { denied: false, rowCount: r.rowCount, code: null };
  } catch (e) {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await c.query(`RELEASE SAVEPOINT ${sp}`);
    return { denied: true, rowCount: 0, code: e.code };
  }
}

/* ── Fixture creation ──────────────────────────────────────────────────────
 *
 * A tenant table is only testable if a row can be put in it, and most of them
 * cannot be filled in isolation: they carry NOT NULL foreign keys, so a row
 * needs a parent, whose parent needs a grandparent. The first version of this
 * script gave up whenever it met a required uuid column, which is why it
 * covered 13 of 50 strict tables.
 *
 * Inventing a uuid instead would be worse than useless — the FK would reject
 * it, and if it did not, the test would be exercising a row the application
 * could never create. So the graph is read from pg_constraint and walked:
 * to build a child, build its parents first.
 */

/** Foreign keys of `table`: which local column points at which parent. */
async function foreignKeys(admin, table, cache) {
  if (cache.has(table)) return cache.get(table);
  const { rows } = await admin.query(`
    SELECT att.attname AS column_name,
           cl.relname  AS parent_table,
           patt.attname AS parent_column
      FROM pg_constraint con
      JOIN pg_class    c   ON c.oid = con.conrelid
      JOIN pg_class    cl  ON cl.oid = con.confrelid
      JOIN unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)  ON true
      JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
      JOIN pg_attribute att  ON att.attrelid = con.conrelid  AND att.attnum = k.attnum
      JOIN pg_attribute patt ON patt.attrelid = con.confrelid AND patt.attnum = fk.attnum
     WHERE con.contype = 'f' AND c.relname = $1
       AND c.relnamespace = 'public'::regnamespace`, [table]);
  cache.set(table, rows);
  return rows;
}

/**
 * Values a CHECK constraint will actually accept, per column.
 *
 * Most skips were 23514: a status column defaulted to the fixture's generic
 * string and the table's own CHECK rejected it. Rather than hardcode each
 * table's vocabulary, read the constraint and take a value it permits —
 * enum-style checks (`col = ANY (ARRAY['a','b'])`, `col IN ('a','b')`) are
 * the shape that accounts for nearly all of them.
 */
async function checkAllowedValues(admin, table, cache) {
  if (cache.has(table)) return cache.get(table);
  const { rows } = await admin.query(`
    SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE con.contype='c' AND c.relname=$1 AND c.relnamespace='public'::regnamespace`, [table]);
  const map = new Map();
  for (const { def } of rows) {
    // CHECK (((status)::text = ANY ((ARRAY['a'::character varying, …])::text[])))
    const m = def.match(/\(?\(?([a-zA-Z_][a-zA-Z0-9_]*)\)?::?\w*\s*(?:=\s*ANY|IN)\s*\(?\(?ARRAY?\s*\[([^\]]+)\]/i)
           || def.match(/\(?\(?([a-zA-Z_][a-zA-Z0-9_]*)\)?::?\w*\s*IN\s*\(([^)]+)\)/i);
    if (!m) continue;
    const first = (m[2].match(/'([^']+)'/) || [])[1];
    if (first && !map.has(m[1])) map.set(m[1], first);
  }
  cache.set(table, map);
  return map;
}

/** Columns that must be supplied: NOT NULL, no default. */
async function requiredColumns(admin, table, cache) {
  if (cache.has(table)) return cache.get(table);
  const { rows } = await admin.query(`
    SELECT column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  cache.set(table, rows);
  return rows;
}

/**
 * Create one row in `table` for `orgId`, creating any parents it requires.
 *
 * Returns { id } on success, or { skipped: reason } — never a fabricated key.
 * `seen` carries the ancestry of the current descent so a cycle is reported
 * rather than recursed into forever.
 */
async function makeFixture(admin, table, orgId, ctx, seen = []) {
  if (seen.includes(table)) return { skipped: `cycle ${[...seen, table].join(' → ')}` };
  if (seen.length > 6) return { skipped: `dependency chain deeper than 6 (${seen.join(' → ')})` };

  const cols = await requiredColumns(admin, table, ctx.colCache);
  const fks = await foreignKeys(admin, table, ctx.fkCache);
  const allowed = await checkAllowedValues(admin, table, ctx.chkCache);
  const fkByCol = new Map(fks.map((f) => [f.column_name, f]));

  const names = [], vals = [];
  for (const c of cols) {
    if (c.column_name === 'organization_id') { names.push(c.column_name); vals.push(orgId); continue; }
    if (c.is_nullable === 'YES' || c.column_default !== null) continue;
    if (allowed.has(c.column_name)) { names.push(c.column_name); vals.push(allowed.get(c.column_name)); continue; }

    const fk = fkByCol.get(c.column_name);
    if (fk) {
      // Reuse a parent already made for this tenant before making another.
      const key = `${fk.parent_table}:${orgId}`;
      let parentId = ctx.made.get(key);
      if (parentId === undefined) {
        const r = await makeFixture(admin, fk.parent_table, orgId, ctx, [...seen, table]);
        if (r.skipped) return { skipped: `needs ${fk.parent_table}: ${r.skipped}` };
        parentId = r.id;
        ctx.made.set(key, parentId);
      }
      if (parentId === null || parentId === undefined) return { skipped: `parent ${fk.parent_table} produced no id` };
      names.push(c.column_name); vals.push(parentId);
      continue;
    }

    const t = c.udt_name;
    let v;
    if (/^(int2|int4|int8|numeric|float4|float8)$/.test(t)) v = 0;
    else if (t === 'bool') v = false;
    else if (/^(timestamptz|timestamp|date|time)$/.test(t)) v = new Date().toISOString();
    else if (t === 'jsonb' || t === 'json') v = '{}';
    else if (t === 'uuid') v = crypto.randomUUID();       // not an FK: a free id
    else if (/^(text|varchar|bpchar|citext|name)$/.test(t)) v = `rls-${ctx.run}-${Math.random().toString(36).slice(2, 8)}`;
    else return { skipped: `unsupported required column ${c.column_name} (${t})` };
    names.push(c.column_name); vals.push(v);
  }

  // Only the table under test must be tenant-scoped. A parent created on the
  // way there legitimately may not be — platform_features, subscription_plans
  // and clients are all shared or platform-owned, and refusing to build them
  // was blocking six otherwise-testable children.
  if (seen.length === 0 && !names.includes('organization_id')) {
    return { skipped: 'no organization_id column' };
  }
  const ph = names.map((_, i) => `$${i + 1}`).join(',');
  const sql = `INSERT INTO public.${table} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${ph}) RETURNING *`;
  try {
    const { rows } = await admin.query(sql, vals);
    return { id: rows[0] && (rows[0].id ?? null), row: rows[0] };
  } catch (e) {
    return { skipped: `${e.code}: ${e.message.slice(0, 70)}` };
  }
}

/** The INSERT statement (not executed) that would create a row for `orgId`. */
async function insertStatementFor(admin, table, orgId, ctx) {
  const cols = await requiredColumns(admin, table, ctx.colCache);
  const fks = await foreignKeys(admin, table, ctx.fkCache);
  const allowed = await checkAllowedValues(admin, table, ctx.chkCache);
  const fkByCol = new Map(fks.map((f) => [f.column_name, f]));
  const names = [], vals = [];
  for (const c of cols) {
    if (c.column_name === 'organization_id') { names.push(c.column_name); vals.push(orgId); continue; }
    if (c.is_nullable === 'YES' || c.column_default !== null) continue;
    if (allowed.has(c.column_name)) { names.push(c.column_name); vals.push(allowed.get(c.column_name)); continue; }
    const fk = fkByCol.get(c.column_name);
    if (fk) {
      const parentId = ctx.made.get(`${fk.parent_table}:${orgId}`);
      if (parentId === undefined) return null;
      names.push(c.column_name); vals.push(parentId);
      continue;
    }
    const t = c.udt_name;
    let v;
    if (/^(int2|int4|int8|numeric|float4|float8)$/.test(t)) v = 0;
    else if (t === 'bool') v = false;
    else if (/^(timestamptz|timestamp|date|time)$/.test(t)) v = new Date().toISOString();
    else if (t === 'jsonb' || t === 'json') v = '{}';
    else if (t === 'uuid') v = crypto.randomUUID();
    else if (/^(text|varchar|bpchar|citext|name)$/.test(t)) v = `rls-${ctx.run}-${Math.random().toString(36).slice(2, 8)}`;
    else return null;
    names.push(c.column_name); vals.push(v);
  }
  if (!names.includes('organization_id')) return null;
  const ph = names.map((_, i) => `$${i + 1}`).join(',');
  return { sql: `INSERT INTO public.${table} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${ph})`, vals };
}

(async () => {
  head('SETUP — fresh database, foundation + migrations');
  // RLS_SKIP_BOOTSTRAP lets this run against a database somebody else built.
  // The only reason it exists: the three pgvector migrations cannot apply on
  // a workstation without the extension, so reproducing a harness fault
  // locally would otherwise be impossible and every diagnosis would cost a
  // CI round trip. CI never sets it.
  if (process.env.RLS_SKIP_BOOTSTRAP === '1') {
    note(`reusing existing database ${DB} (RLS_SKIP_BOOTSTRAP=1)`);
  } else {
    const a = await connect(ADMIN_URL);
    await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${DB}`);
    for (const r of ['anon', 'authenticated', 'service_role']) {
      await a.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}')
                     THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$;`);
    }
    await a.end();
    execFileSync(process.execPath, [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60 * 1000,
    });
    emit('  migrations applied');
  }

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
  // Run-scoped slugs so a repeated run against a reused database does not
  // collide on organizations_slug_key, and so each run's fixtures are
  // distinguishable from a previous run's leftovers.
  const RUN = crypto.randomBytes(3).toString('hex');
  const { rows: [A] } = await admin.query(
    `INSERT INTO organizations (name, slug, status) VALUES ('619 Fitness Studio',$1,'active') RETURNING id`,
    [`tenant-a-rls-${RUN}`]);
  const { rows: [B] } = await admin.query(
    `INSERT INTO organizations (name, slug, status) VALUES ('ABC Fitness',$1,'active') RETURNING id`,
    [`tenant-b-rls-${RUN}`]);
  emit(`  tenant A ${A.id}\n  tenant B ${B.id}`);

  // Which tables actually carry a policy, and are strict (not the shared-row
  // variant that also permits organization_id IS NULL)?
  const { rows: policied } = await admin.query(`
    SELECT tablename, qual FROM pg_policies
     WHERE schemaname='public' AND policyname='tenant_isolation' ORDER BY 1`);
  const strict = policied.filter((p) => !/IS NULL/i.test(p.qual || '')).map((p) => p.tablename);
  note(`policies ${policied.length} (strict ${strict.length}, shared ${policied.length - strict.length})`);

  // Seed one row per strict table for each tenant, as the owner, creating
  // whatever parents each table requires.
  const ctx = { colCache: new Map(), fkCache: new Map(), chkCache: new Map(), made: new Map(), run: RUN };
  ctx.made.set(`organizations:${A.id}`, A.id);
  ctx.made.set(`organizations:${B.id}`, B.id);

  const usable = [], skipped = [];
  for (const t of strict) {
    const ra = await makeFixture(admin, t, A.id, ctx);
    if (ra.skipped) { skipped.push({ table: t, reason: ra.skipped }); continue; }
    const rb = await makeFixture(admin, t, B.id, ctx);
    if (rb.skipped) { skipped.push({ table: t, reason: rb.skipped }); continue; }
    usable.push({ table: t, aId: ra.id, bId: rb.id, hasId: ra.id != null && rb.id != null });
  }
  note(`strict tables ${strict.length} | fixtures created ${usable.length} | not covered ${skipped.length}`);
  if (skipped.length) {
    // Every uncovered table is named with its reason: an unexplained gap in a
    // security test is indistinguishable from a passing one.
    for (const s of skipped.slice(0, 40)) emit(`    SKIP  ${s.table} — ${s.reason}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::notice title=RLS coverage::not covered (${skipped.length}): ` +
        skipped.map((s) => `${s.table} [${s.reason}]`).join('; ').slice(0, 900));
    }
  }
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
    // Every table we can build a statement for, not just one: WITH CHECK is
    // per-policy, so one table proving it says nothing about the other 49.
    const forgedOk = [], forgedLeak = [], legitOk = [], legitBlocked = [];
    await withOrg(c, A.id, async () => {
      for (const { table } of usable) {
        const forged = await insertStatementFor(admin, table, B.id, ctx);
        if (forged) {
          const f = await attempt(c, forged.sql, forged.vals);
          (f.denied ? forgedOk : forgedLeak).push(table);
        }
        const own = await insertStatementFor(admin, table, A.id, ctx);
        if (own) {
          const g = await attempt(c, own.sql, own.vals);
          (g.denied ? legitBlocked : legitOk).push(table);
        }
      }
    });
    forgedLeak.length === 0
      ? ok('forged INSERT rejected on every table tried', `${forgedOk.length} tables`)
      : bad('forged INSERT rejected', `accepted on: ${forgedLeak.slice(0, 6).join(', ')}`);
    // Same connection and transaction as the refusals above, so this also
    // proves the savepoints left the tenant context usable.
    legitOk.length > 0
      ? ok('legitimate INSERT still accepted after refusals', `${legitOk.length} tables`)
      : bad('legitimate INSERT still accepted after refusals', `all blocked (${legitBlocked.length})`);
    await c.end();
  }

  head('STEP 9 — UPDATE isolation');
  {
    const c = await asTenant();
    const { table, bId } = usable.find((u) => u.bId) || usable[0];
    await withOrg(c, A.id, async () => {
      const r = await attempt(c, `UPDATE public.${table} SET organization_id=organization_id WHERE organization_id=$1`, [B.id]);
      (r.denied || r.rowCount === 0)
        ? ok("cannot UPDATE another tenant's rows", `${table}, ${r.denied ? r.code : '0 rows'}`)
        : bad("cannot UPDATE another tenant's rows", `${r.rowCount} rows`);

      const m = await attempt(c, `UPDATE public.${table} SET organization_id=$1 WHERE organization_id=$2`, [B.id, A.id]);
      (m.denied || m.rowCount === 0)
        ? ok('cannot move a row A → B', m.denied ? `refused ${m.code}` : '0 rows')
        : bad('cannot move a row A → B', `${m.rowCount} rows moved`);

      if (bId) {
        const byId = await attempt(c, `UPDATE public.${table} SET organization_id=organization_id WHERE id=$1`, [bId]);
        (byId.denied || byId.rowCount === 0)
          ? ok("IDOR: UPDATE by tenant B's id affects nothing")
          : bad('IDOR: UPDATE by id', `${byId.rowCount} rows`);
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
        const r = await attempt(c, `DELETE FROM public.${table} WHERE organization_id=$1`, [B.id]);
        if (!r.denied && r.rowCount > 0) crossDeleted.push(`${table}=${r.rowCount}`);
        if (bId) {
          const d = await attempt(c, `DELETE FROM public.${table} WHERE id=$1`, [bId]);
          if (!d.denied && d.rowCount > 0) idorHits.push(table);
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

  head('STEP 6/7 — shared tables');
  {
    // "Shared" means the policy also admits organization_id IS NULL, for
    // reference content every studio draws on. That is only safe if the NULL
    // rows really are global — a tenant-private row that happens to have a
    // NULL organization_id would be visible to everybody, which is the exact
    // failure this section looks for.
    const shared = policied.filter((p) => /IS NULL/i.test(p.qual || '')).map((p) => p.tablename);
    note(`shared tables (${shared.length}): ${shared.join(', ')}`);
    const cA = await asTenant(), cB = await asTenant();
    const leaks = [];
    for (const t of shared) {
      const priv = await makeFixture(admin, t, B.id, ctx);   // a B-owned row
      const { rows: [g] } = await admin.query(
        `SELECT count(*)::int n FROM public.${t} WHERE organization_id IS NULL`);
      let seenByA = 0, globalByA = 0;
      await withOrg(cA, A.id, async () => {
        const { rows } = await cA.query(
          `SELECT count(*) FILTER (WHERE organization_id=$1)::int other,
                  count(*) FILTER (WHERE organization_id IS NULL)::int glob
             FROM public.${t}`, [B.id]);
        seenByA = rows[0].other; globalByA = rows[0].glob;
      });
      if (seenByA > 0) leaks.push(`${t} (${seenByA} B-owned rows visible to A)`);
      emit(`    ${t.padEnd(28)} global rows ${String(g.n).padStart(4)} | A sees global ${String(globalByA).padStart(4)} | A sees B-owned ${seenByA}` +
           (priv.skipped ? '  [no B fixture: ' + priv.skipped.slice(0, 40) + ']' : ''));
    }
    leaks.length === 0
      ? ok('shared policies expose no tenant-private rows across tenants', `${shared.length} tables`)
      : bad('shared policies leak tenant-private rows', leaks.join('; '));
    await cA.end(); await cB.end();
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
      `SELECT name FROM organizations WHERE slug NOT LIKE 'tenant-%-rls-%'`);
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
  // Surfaced as an annotation, not just logged: a thrown harness error and a
  // real isolation failure both exit 1, and without the message in a
  // token-readable place they are indistinguishable from outside the runner.
  const detail = `${e.message}${e.code ? ` [${e.code}]` : ''}`;
  console.error('\nHARNESS ERROR:', detail);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=RLS harness::${detail}`);
  if (e.stack && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=RLS harness::${e.stack.split('\n').slice(1, 4).join(' | ')}`);
  }
  if (e.stdout) console.error(String(e.stdout).slice(-3000));
  process.exit(1);
});
