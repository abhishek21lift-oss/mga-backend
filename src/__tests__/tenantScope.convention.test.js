// Every route that reads a tenant table must scope it to an organization.
//
// This is the standing guard for audit finding C-2. The finding is structural,
// not a bug list: verified against the live database, the app connects as
// `postgres`, which has rolbypassrls = true, and of 247 RLS policies in
// `public` exactly ZERO are organization-scoped. Every existing policy is a
// deny-all for the PostgREST `anon`/`authenticated` roles — protection against
// a leaked publishable key, not against this API.
//
// So the database cannot catch a query that forgets its tenant filter. There
// is no backstop under the application. With six live studios in production,
// one missed filter in one route is a cross-tenant data leak, and nothing
// below the Express layer would notice.
//
// Enforcing real RLS is the durable fix, and it is deliberately NOT what this
// test does — see db/migrations/TENANT-RLS-PLAN.md for the verified policy
// design and the reason it cannot land as a migration alone. Until that ships,
// the honest mitigation is to make the omission loud on the branch instead of
// silent in production. That is this test.
//
// ── Why the check is static ─────────────────────────────────────────────
//
// Same reasoning as rls.convention.test.js next door: CI has no live database,
// and a runtime check would only catch the mistake after it shipped. Reading
// the source catches it before merge.
//
// ── Why it is coarse, deliberately ──────────────────────────────────────
//
// It asserts file-level awareness — a file that queries a tenant table must
// reference the tenant helpers somewhere — not per-query correctness. A
// per-query analyser over 839 call sites would need to understand every
// dynamic WHERE-clause builder in the codebase, and would produce false
// positives on correct code. A test that cries wolf gets deleted (the comment
// in rls.convention.test.js makes the same point), so this one is built to
// have a near-zero false-positive rate and catch the failure that actually
// happens: a whole new route file written without tenancy in mind.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

/**
 * Tables that carry organization_id, derived from the migrations rather than
 * hardcoded, so a tenant table added next month is covered without anyone
 * remembering to update this list.
 */
function tenantTables() {
  const found = new Set();
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, ' ');
    // Retrofit form: ALTER TABLE foo ADD COLUMN ... organization_id
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN[^;]*?organization_id/gi
    )) found.add(m[1].toLowerCase());
    // Born-multi-tenant form: CREATE TABLE foo ( ... organization_id ... )
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(([\s\S]*?)\n\s*\)/gi
    )) if (/\borganization_id\b/i.test(m[2])) found.add(m[1].toLowerCase());
  }
  return found;
}

/**
 * Tables whose rows are platform-global by design, where a bare
 * `organization_id = $org` filter would be the bug rather than the fix.
 *
 * Confirmed against production, not assumed: `exercises` holds 890 rows and
 * every single one has organization_id IS NULL — it is the shared exercise
 * library every studio draws from. Scoping it strictly would empty the library
 * for all six studios at once. Same shape for the reference tables below;
 * login_events is NULL for the 131 failed attempts where no user was
 * identified yet, so there was no org to record.
 */
const PLATFORM_GLOBAL = new Set([
  'exercises',
  'muscle_volume_landmarks',
  'diet_templates',
  'login_events',
]);

/**
 * Files allowed to touch a tenant table without referencing the tenant
 * helpers. Each entry is a reviewed exception with the reason it is safe —
 * NOT a place to silence a failure. Adding one means asserting the file
 * genuinely cannot leak across tenants.
 */
const REVIEWED_EXCEPTIONS = {
  'routes/public.js':
    'GET /api/public/stats — unauthenticated marketing endpoint returning ' +
    'platform-wide COUNTs only (studios, trainers, active clients, sessions). ' +
    'Aggregates across all tenants is the intended behaviour; it returns no ' +
    'rows, no identifiers and no PII.',
  'modules/automation/automation.routes.js':
    'LEFT JOIN users u ON u.id = ar.created_by — resolves an author name for ' +
    'automation rows the surrounding query already filters. Join is on an FK.',
  'modules/command-center/alerts.service.js':
    'Platform-operator alerting. Both user queries are explicitly ' +
    "WHERE role = 'super_admin', i.e. accounts that have no organization by " +
    'design. Mounted under /api/super-admin behind requireSuperAdmin.',
  'modules/command-center/collectors/smtp.collector.js':
    'Command Center SMTP health collector — reads admin_invitations delivery ' +
    'errors platform-wide, which is the operator console\'s purpose. Mounted ' +
    'under /api/super-admin behind requireSuperAdmin + requireSuperAdminMfa.',
  'modules/platform/super-admin/shared.js':
    'audit() logs super-admin actions (organisation suspend/activate, plan ' +
    'changes, impersonation, invitations) that operate ON a tenant from ' +
    'outside it, or across several — the action does not have one owning ' +
    'organisation to filter by the way a business write does. Same shape as ' +
    'the Command Centre alerting exception above. Mounted under ' +
    '/api/super-admin behind requireSuperAdmin.',
};

/** Every route/module source file. */
function sourceFiles() {
  const out = [];
  for (const root of ['routes', 'modules']) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(path.join(SRC, root));
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

/** Tenant tables this file actually reads or writes. */
function tenantTablesUsedBy(src, tables) {
  const body = src.replace(/--[^\n]*/g, ' ');
  return [...tables].filter(
    (t) => !PLATFORM_GLOBAL.has(t) && new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, 'i').test(body)
  );
}

/** Does the file show any awareness of the tenant boundary at all? */
function scopesByTenant(src) {
  return /tenantScope|orgIdOf|resolveOrgId|organization_id|orgGuard|clientInOrg|requireSuperAdmin/.test(src);
}

describe('tenant-scope convention — no route reads a tenant table unscoped', () => {
  const tables = tenantTables();
  const files = sourceFiles();

  it('derives the tenant-table list from the migrations, so it cannot pass vacuously', () => {
    // If this drops, the regex above stopped matching the migration style and
    // every assertion below silently checks nothing.
    expect(tables.size).toBeGreaterThan(30);
    for (const core of ['pt_clients', 'pt_payments', 'attendance_logs', 'invoices']) {
      expect(tables.has(core)).toBe(true);
    }
  });

  it('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('every file querying a tenant table references the tenant boundary', () => {
    const offenders = [];
    for (const f of files) {
      const name = rel(f);
      if (REVIEWED_EXCEPTIONS[name]) continue;
      const src = fs.readFileSync(f, 'utf8');
      const used = tenantTablesUsedBy(src, tables);
      if (used.length && !scopesByTenant(src)) {
        offenders.push(`${name} → ${used.slice(0, 5).join(', ')}`);
      }
    }
    // A failure here means a file reads tenant-owned rows with no visible
    // organization filter, and the database will NOT stop it — the API role
    // bypasses RLS. Fix by scoping the query through lib/tenant-db.js:
    //
    //   const { orgId, applyFilter } = tenantScope(req);
    //   ... WHERE ($1::uuid IS NULL OR organization_id = $1) ...
    //
    // If the file is a genuine exception (platform-wide aggregate, super-admin
    // route, name-resolution join on an already-scoped row), add it to
    // REVIEWED_EXCEPTIONS above WITH the reason it cannot leak.
    expect(offenders).toEqual([]);
  });

  it('keeps the exception list honest — every entry still exists and still needs to be there', () => {
    // Stops the list becoming a graveyard that silently exempts files which
    // were later rewritten, moved, or fixed.
    const stale = [];
    for (const [name, reason] of Object.entries(REVIEWED_EXCEPTIONS)) {
      const full = path.join(SRC, name);
      if (!fs.existsSync(full)) { stale.push(`${name} (file no longer exists)`); continue; }
      const src = fs.readFileSync(full, 'utf8');
      if (!tenantTablesUsedBy(src, tables).length) {
        stale.push(`${name} (no longer touches a tenant table — drop the exception)`);
      }
      expect(reason.length).toBeGreaterThan(40); // a real reason, not "ok"
    }
    expect(stale).toEqual([]);
  });
});
