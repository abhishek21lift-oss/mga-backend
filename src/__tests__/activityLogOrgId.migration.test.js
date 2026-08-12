'use strict';
// 158_activity_log_organization_id.sql — adds the column the business-write
// audit trail depends on, and re-applies 157's RLS discovery so activity_log
// is covered by it too. Pinned the same way appTenantRls.migration.test.js
// pins 157: the shared/global table list here must never drift from the one
// migration 155's own test already maintains, and the new column must
// actually be backfilled and indexed, not just declared.

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '158_activity_log_organization_id.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

const ORG_NOT_NULL_TEST = fs.readFileSync(
  path.join(__dirname, 'migrations.orgNotNull.test.js'), 'utf8');

function migrationSharedTables() {
  const m = body.match(/shared_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
}

function orgNotNullSharedTables() {
  const m = ORG_NOT_NULL_TEST.match(/const SHARED_TABLES = \[([\s\S]*?)\];/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
}

describe('158_activity_log_organization_id.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(200);
  });

  it('adds organization_id to activity_log, indexed and additive', () => {
    expect(body).toMatch(/ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS organization_id UUID/);
    expect(body).toContain('CREATE INDEX IF NOT EXISTS idx_activity_log_organization_id ON activity_log');
    expect(body).not.toMatch(/SET NOT NULL/);
    expect(body).not.toMatch(/DROP TABLE/i);
    // The only DROP anywhere here is the re-applied policy's own
    // idempotency guard (matches 157) — never a policy other than its own.
    expect(body).not.toMatch(/DROP POLICY(?! IF EXISTS tenant_isolation)/);
  });

  it('backfills from the acting user\'s own org, same shape as 084/156', () => {
    expect(body).toMatch(/UPDATE activity_log a[\s\S]*?SET organization_id = u\.organization_id[\s\S]*?FROM users u/);
  });

  it('drops any stray trigger on activity_log before backfilling it', () => {
    // Production carries a BEFORE UPDATE trigger on activity_log that no
    // tracked migration created (001_v4_upgrade.sql's set_updated_at() loop
    // does not include activity_log). It references a column the table has
    // never had, so the backfill UPDATE above fails against real data unless
    // this runs first — order matters, not just presence.
    const dropAt = body.indexOf('DROP TRIGGER %I ON public.activity_log');
    const backfillAt = body.indexOf('UPDATE activity_log a');
    expect(dropAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(dropAt);
    expect(body).toContain("pg_trigger");
    expect(body).toContain('NOT tgisinternal');
  });

  it('re-runs the RLS discovery loop rather than hand-writing a second policy for one table', () => {
    expect(body).toContain("column_name = 'organization_id'");
    expect(body).toMatch(/FOR tbl IN[\s\S]*?LOOP/);
    expect(body).toContain('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY');
  });

  it('grants the re-applied policy only to app_tenant, same guard as 157', () => {
    const grants = [...body.matchAll(/CREATE POLICY tenant_isolation[\s\S]*?FOR ALL TO ([a-z_'|]+)/g)]
      .map((m) => m[1]);
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).toBe('app_tenant');
    expect(body).not.toMatch(/TO\s+(public|anon|authenticated)\b/);
  });

  it('answers the shared-table question identically to 157 and to migration 155\'s own test', () => {
    const here = migrationSharedTables();
    const there = orgNotNullSharedTables();
    expect(here.length).toBeGreaterThan(5);
    expect([...here].sort()).toEqual([...there].sort());
  });
});
