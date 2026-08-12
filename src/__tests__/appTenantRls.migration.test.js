'use strict';
// 157_app_tenant_role_and_rls.sql — the RLS half of TENANT-RLS-PLAN.md's
// design. Pinned here rather than trusted by eye because the two things
// that would make this migration actively dangerous instead of merely
// inert (granting a tenant-isolation policy to `public` instead of
// app_tenant — the exact mistake migration 131 had to undo — or hand-
// listing the shared/global tables and letting the answer here drift from
// the answer migrations.orgNotNull.test.js already gives) are both easy
// to get right by construction and easy to get wrong by a one-word edit.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '157_app_tenant_role_and_rls.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

const ORG_NOT_NULL_TEST = fs.readFileSync(
  path.join(__dirname, 'migrations.orgNotNull.test.js'), 'utf8');

/** The shared_tables array literal inside this migration's DO block. */
function migrationSharedTables() {
  const m = body.match(/shared_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
}

/** The same list, parsed out of migrations.orgNotNull.test.js's own source
 *  — not required as a module, which would re-run that file's test suite a
 *  second time under this one. */
function orgNotNullSharedTables() {
  const m = ORG_NOT_NULL_TEST.match(/const SHARED_TABLES = \[([\s\S]*?)\];/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
}

describe('157_app_tenant_role_and_rls.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(200);
  });

  it('creates app_tenant guarded, and only that — never SUPERUSER or BYPASSRLS', () => {
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant'\)/);
    expect(body).toContain('NOSUPERUSER');
    expect(body).toContain('NOBYPASSRLS');
    // A bare BYPASSRLS (not preceded by "NO") would grant exactly the
    // privilege this role exists to not have.
    expect(body).not.toMatch(/(?<!NO)BYPASSRLS/);
  });

  it('sets no password — a migration file is version-controlled', () => {
    expect(body.toUpperCase()).not.toContain('PASSWORD');
  });

  it('discovers tenant tables from the schema rather than a hand-maintained list', () => {
    expect(body).toContain("column_name = 'organization_id'");
    expect(body).toMatch(/FOR tbl IN[\s\S]*?LOOP/);
    expect(body).toContain('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY');
  });

  it('grants the tenant_isolation policy only to app_tenant — never public, anon, or authenticated', () => {
    // Migration 131 had to drop policies granted to `public` with nothing
    // setting the GUC — everyone who could set it got everything. Every
    // CREATE POLICY here must name app_tenant, and none may fall through
    // to the roles that mistake was made with.
    const grants = [...body.matchAll(/CREATE POLICY tenant_isolation[\s\S]*?FOR ALL TO ([a-z_'|]+)/g)]
      .map((m) => m[1]);
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).toBe('app_tenant');
    expect(body).not.toMatch(/TO\s+(public|anon|authenticated)\b/);
  });

  it('never drops or alters a policy other than its own tenant_isolation', () => {
    expect(body).not.toMatch(/DROP POLICY(?! IF EXISTS tenant_isolation)/);
  });

  it('gives shared/platform-global tables the OR organization_id IS NULL clause, and only those', () => {
    expect(body).toContain('OR organization_id IS NULL');
    // The strict-table branch must not also carry the exception.
    const strictBranch = body.slice(body.indexOf('ELSE'), body.indexOf('END IF;'));
    expect(strictBranch).not.toContain('IS NULL');
  });

  it('answers "does this table have legitimate NULL organization_id rows" identically to migration 155\'s own test', () => {
    const here = migrationSharedTables();
    const there = orgNotNullSharedTables();
    expect(here.length).toBeGreaterThan(5); // catches an empty/unparsed array on either side
    expect([...here].sort()).toEqual([...there].sort());
  });

  it('is additive — grants and enables RLS, never revokes, drops a table, or deletes data', () => {
    expect(body).not.toMatch(/\bREVOKE\b/);
    expect(body).not.toMatch(/DROP TABLE/i);
    expect(body).not.toMatch(/\bDELETE FROM\b/i);
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
  });
});
