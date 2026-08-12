// Every new table must ship with Row Level Security.
//
// This test is the real fix for audit finding C-01. Migration 131 cleaned up
// the 15 tables that had RLS disabled while `anon` held SELECT and INSERT on
// them — but a cleanup fixes the past. Those 15 were not one mistake, they
// were the same omission repeated across months of separate commits, each of
// which looked fine in review. Nothing caught them until a linter did.
//
// So this fails the build when a migration creates a table and forgets.
//
// ── Why the check is static ─────────────────────────────────────────────
//
// The obvious test queries pg_class and asserts relrowsecurity everywhere.
// That needs a live database, which CI does not have and which would only
// catch the mistake AFTER it shipped. Reading the migration files catches it
// on the branch, before it reaches a database at all — and this suite already
// reads server.js the same way to verify route wiring.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

// The convention (ENABLE RLS + deny-all + REVOKE) starts at 104_coupons.sql.
// Everything before it predates the rule and was brought into line wholesale
// by 131, so holding those files to it would fail the build for history that
// has already been corrected in the database.
const CONVENTION_FROM = 104;

/** Migration files at or after the cutoff, in order. */
function migrations() {
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, n: parseInt(f.slice(0, 3), 10) }))
    .filter((m) => Number.isFinite(m.n) && m.n >= CONVENTION_FROM)
    .sort((a, b) => a.n - b.n)
    .map((m) => ({ ...m, sql: fs.readFileSync(path.join(DIR, m.file), 'utf8') }));
}

/**
 * Strip SQL comments before parsing.
 *
 * Without this, prose describing the convention counts as the convention —
 * a line reading "-- CREATE TABLE IF NOT EXISTS then becomes a no-op" was
 * being reported as an unprotected table named `then`.
 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Table names a migration CREATEs. Ignores IF NOT EXISTS / schema prefixes. */
function tablesCreatedBy(sql) {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(/gi;
  return [...new Set([...stripComments(sql).matchAll(re)].map((m) => m[1].toLowerCase()))];
}

/**
 * Does the migration protect this table?
 *
 * Two shapes count, because the codebase legitimately uses both:
 *
 *   1. Naming the table —  ALTER TABLE foo ENABLE ROW LEVEL SECURITY
 *   2. A loop over an array of names, applying
 *      format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t)
 *
 * Shape 2 is what 104, 116 and 131 use, and a check that only understood
 * shape 1 would report every one of them as unprotected. A test that cries
 * wolf on correct code gets deleted, so it has to understand the real
 * convention rather than the one I would have written.
 */
function protects(sql, table) {
  const body = stripComments(sql);
  const named = new RegExp(
    `ALTER\\s+TABLE\\s+(?:public\\.)?["']?${table}["']?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i');
  if (named.test(body)) return true;

  // Loop form: the migration applies RLS by identifier, and the table is
  // among the names it iterates.
  const loops = /format\(\s*['"]ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/i.test(body);
  return loops && new RegExp(`['"]${table}['"]`).test(body);
}

/** Same two shapes, for the REVOKE half of the convention. */
function revokes(sql, table) {
  const body = stripComments(sql);
  const named = new RegExp(
    `REVOKE\\s+ALL\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?["']?${table}["']?[^;]*FROM[^;]*anon`, 'i');
  if (named.test(body)) return true;
  const loops = /format\(\s*['"]REVOKE ALL ON public\.%I FROM anon/i.test(body);
  return loops && new RegExp(`['"]${table}['"]`).test(body);
}

describe('RLS convention — every new table is protected', () => {
  const all = migrations();

  it('finds migrations to check, so this cannot pass vacuously', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it('enables RLS on every table it creates', () => {
    const missing = [];
    for (const m of all) {
      // The sweep migration protects tables it never names.
      if (/close_rls_gaps/.test(m.file)) continue;
      for (const t of tablesCreatedBy(m.sql)) {
        if (!protects(m.sql, t)) missing.push(`${m.file} → ${t}`);
      }
    }
    // A failure here means a table is reachable through PostgREST with the
    // publishable key, bypassing the API and every tenant check in it.
    // Add to the migration:
    //   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
    //   REVOKE ALL ON <t> FROM anon, authenticated;
    //   CREATE POLICY deny_all_direct_access ON <t>
    //     FOR ALL USING (false) WITH CHECK (false);
    expect(missing).toEqual([]);
  });

  it('revokes anon and authenticated on every table it creates', () => {
    // RLS alone is enough to deny, so this is defence in depth — but it is
    // the layer that survives someone adding a permissive policy later for
    // one legitimate case and accidentally widening the table.
    const missing = [];
    for (const m of all) {
      if (/close_rls_gaps/.test(m.file)) continue;
      for (const t of tablesCreatedBy(m.sql)) {
        if (!revokes(m.sql, t)) missing.push(`${m.file} → ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the sweep migration itself', () => {
  const sweep = fs.readFileSync(path.join(DIR, '131_close_rls_gaps.sql'), 'utf8');

  it('covers every table rather than a list', () => {
    // A migration naming the 15 would fix the instances and teach nothing.
    // This one iterates pg_class, so tables nobody thought to check are
    // covered too.
    expect(sweep).toMatch(/FROM pg_class/);
    expect(sweep).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sweep).toMatch(/REVOKE ALL/);
  });

  it('drops the four GUC policies that granted access on a settable flag', () => {
    // Each was `USING (... current_setting('app.role') = 'admin')` granted to
    // public FOR ALL. Nothing sets those GUCs, so they denied by accident;
    // anyone who could set one got everything. webauthn_credentials holds
    // authentication material.
    for (const p of [
      'biometric_attendance_member_policy',
      'gym_settings_admin_policy',
      'webauthn_challenges_member_policy',
      'webauthn_credentials_member_policy',
    ]) {
      expect(sweep).toContain(`DROP POLICY IF EXISTS ${p}`);
    }
  });

  it('strips default privileges so a new table cannot arrive pre-exposed', () => {
    expect(sweep).toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*REVOKE ALL ON TABLES FROM anon, authenticated/);
  });

  it('is idempotent — safe to re-run', () => {
    // migrate.js runs each file once, but a restored branch or a manual
    // re-apply must not error.
    expect(sweep).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_policies/);
    expect(sweep).toMatch(/DROP POLICY IF EXISTS/);
  });
});
