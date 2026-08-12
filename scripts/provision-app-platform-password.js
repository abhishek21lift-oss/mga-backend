#!/usr/bin/env node
'use strict';
/**
 * One-time bootstrap: give the `app_platform` role a password.
 *
 * 163 creates app_platform WITH LOGIN and no password, deliberately — a
 * password in a migration is a password in git forever. Until this runs, the
 * role exists, holds its allowlist, and cannot log in, which is the safe order.
 *
 *   APP_PLATFORM_PASSWORD     the new password (never printed, never stored)
 *   MIGRATION_DATABASE_URL    a role with ADMIN OPTION on app_platform
 *
 * Usage (keep it out of shell history — read it, don't paste it):
 *
 *   APP_PLATFORM_PASSWORD="$(read -rs -p 'password: ' p; echo "$p")" \
 *   MIGRATION_DATABASE_URL=... node scripts/provision-app-platform-password.js
 *
 * This is the sibling of provision-app-tenant-password.js and works the same
 * way, including hashing the password locally so the plaintext never reaches
 * the query log (see scripts/lib/scram.js). It does more afterwards: because
 * app_platform can read across every organisation, the checks below do not
 * stop at "the flags say NOBYPASSRLS" — they attempt the forbidden operations
 * and require them to fail.
 */

const { Client } = require('pg');
const { scramVerifier, DEFAULT_ITERATIONS } = require('./lib/scram');

const ROLE = 'app_platform';
const MIN_PASSWORD_LENGTH = 16;

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const password = process.env.APP_PLATFORM_PASSWORD || '';
const dbUrl = process.env.MIGRATION_DATABASE_URL || '';

if (!dbUrl) fail('MIGRATION_DATABASE_URL must be set');
if (!password) fail('APP_PLATFORM_PASSWORD must be set and non-empty');
if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`APP_PLATFORM_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}
if (!/^[\x21-\x7e]+$/.test(password)) {
  fail('APP_PLATFORM_PASSWORD must be printable ASCII with no spaces');
}
// No character-class rule, for the same reason as the tenant role: this is a
// machine credential nobody types, and rejecting a random 32-byte string for
// lacking a digit enforces a rule written for human-chosen passwords.

const NEEDS_ENCODING = /[:/?#[\]@%&=+$,; ]/.test(password);
const ssl = (u) => (/sslmode=disable/.test(u) ? false : { rejectUnauthorized: false });

const FLAGS = `
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin,
         has_schema_privilege($1,'public','CREATE') AS create_on_public,
         has_schema_privilege($1,'public','USAGE')  AS usage_on_public
    FROM pg_roles WHERE rolname = $1`;

const ROLE_CENSUS = `
  SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
         rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil,
         (rolpassword IS NOT NULL) AS has_password
    FROM pg_authid ORDER BY rolname`;

function deriveUrl(privilegedUrl, plaintext) {
  const u = new URL(privilegedUrl);
  const user = decodeURIComponent(u.username);
  const dot = user.indexOf('.');
  // Supabase's pooler authenticates as "<role>.<project_ref>", so the ref is
  // carried across rather than the username simply replaced.
  u.username = dot === -1 ? ROLE : `${ROLE}${user.slice(dot)}`;
  u.password = plaintext;
  return { url: u.toString(), user: u.username };
}

(async () => {
  const admin = new Client({ connectionString: dbUrl, ssl: ssl(dbUrl), statement_timeout: 30_000 });
  await admin.connect();

  let target;
  try {
    const { rows: exists } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    if (!exists.length) fail(`role ${ROLE} does not exist — run migration 163 first`);

    const { rows: [auth] } = await admin.query(`
      SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
             EXISTS (SELECT 1 FROM pg_auth_members m
                       JOIN pg_roles r ON r.oid = m.roleid
                       JOIN pg_roles g ON g.oid = m.member
                      WHERE r.rolname = $1 AND g.rolname = current_user
                        AND m.admin_option) AS has_admin`, [ROLE]);
    if (!auth.is_super && !auth.has_admin) {
      fail(`current role has neither SUPERUSER nor ADMIN OPTION on ${ROLE}`);
    }

    const rolesBefore = (await admin.query(ROLE_CENSUS)).rows;

    await admin.query(
      `ALTER ROLE ${ROLE} WITH PASSWORD ${admin.escapeLiteral(scramVerifier(password, DEFAULT_ITERATIONS))}`
    );

    const { rows: [post] } = await admin.query(FLAGS, [ROLE]);
    const mustBeFalse = ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'];
    const raised = mustBeFalse.filter((f) => post[f] !== false);
    if (raised.length) fail(`${ROLE} gained privileges: ${raised.join(', ')}`);
    if (post.create_on_public !== false) fail(`${ROLE} has CREATE on schema public`);
    if (post.rolcanlogin !== true) fail(`${ROLE} cannot log in`);

    // No other role may have moved. app_platform is allowed to differ in
    // exactly one field, has_password, and in nothing else.
    const rolesAfter = (await admin.query(ROLE_CENSUS)).rows;
    if (rolesBefore.length !== rolesAfter.length) fail('the set of roles changed');
    const strip = (r) => { const c = { ...r }; delete c.has_password; return c; };
    for (let i = 0; i < rolesAfter.length; i += 1) {
      const [a, b] = [rolesBefore[i], rolesAfter[i]];
      if (a.rolname !== b.rolname) fail('role ordering changed');
      if (a.rolname === ROLE) {
        if (JSON.stringify(strip(a)) !== JSON.stringify(strip(b))) {
          fail(`${ROLE} attributes changed beyond its password`);
        }
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        fail(`role ${b.rolname} was modified`);
      }
    }

    target = deriveUrl(dbUrl, password);

    console.log(`✓ ${ROLE} password set`);
    console.log('');
    console.log('  privilege flags');
    for (const f of mustBeFalse) console.log(`    ${f.replace('rol', '').padEnd(13)}: ${post[f]}`);
    console.log(`    ${'LOGIN'.padEnd(13)}: ${post.rolcanlogin}   (required true)`);
    console.log(`    ${'CREATE public'.padEnd(13)}: ${post.create_on_public}   (required false)`);
    console.log(`    other roles modified: 0 of ${rolesAfter.length - 1}`);
  } finally {
    await admin.end();
  }

  // ── Login, and then the operations that must NOT work ──────────────────
  const probe = new Client({
    connectionString: target.url,
    ssl: ssl(target.url),
    statement_timeout: 15_000,
    connectionTimeoutMillis: 20_000,
  });
  try {
    await probe.connect();
    const { rows: [who] } = await probe.query(`
      SELECT current_user,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
             (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
             has_schema_privilege(current_user,'public','CREATE') AS create_on_public`);
    if (who.current_user !== ROLE) fail(`authenticated as ${who.current_user} rather than ${ROLE}`);
    if (who.bypassrls !== false) fail('session has BYPASSRLS');
    if (who.super !== false) fail('session is SUPERUSER');
    if (who.create_on_public !== false) fail('session has CREATE on public');

    // Attempted, not assumed. A flag that says NOBYPASSRLS and a session that
    // actually cannot write the schema are different claims, and only the
    // second one is worth reporting.
    const denied = [];
    const mustFail = async (label, sql) => {
      await probe.query('SAVEPOINT s');
      try {
        await probe.query(sql);
        await probe.query('ROLLBACK TO SAVEPOINT s');
        fail(`${ROLE} was able to: ${label} — this must not be possible`);
      } catch (e) {
        await probe.query('ROLLBACK TO SAVEPOINT s').catch(() => {});
        denied.push(`${label} → ${e.code}`);
      }
    };

    await probe.query('BEGIN');
    await mustFail('CREATE TABLE', 'CREATE TABLE platform_probe_should_fail(id int)');
    await mustFail('CREATE SCHEMA', 'CREATE SCHEMA platform_probe_should_fail');
    await mustFail('DROP TABLE organizations', 'DROP TABLE public.organizations');
    await mustFail('ALTER TABLE users', 'ALTER TABLE public.users ADD COLUMN probe_col int');
    await mustFail('DELETE FROM users', 'DELETE FROM public.users');
    await mustFail('DELETE FROM organizations', 'DELETE FROM public.organizations');
    await mustFail('SET ROLE app_tenant', 'SET ROLE app_tenant');

    // Chosen at run time rather than hardcoded. A named table that has since
    // been dropped would fail with 42P01 "does not exist", which looks like a
    // refusal in the output but proves nothing about privileges — so the
    // table is picked from the catalogue precisely because it exists and is
    // NOT in 163's allowlist.
    const { rows: [outsider] } = await probe.query(`
      SELECT c.relname AS t
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.role_table_grants g
            WHERE g.table_schema = 'public' AND g.table_name = c.relname
              AND g.grantee = '${ROLE}')
       ORDER BY c.relname LIMIT 1`);
    if (!outsider) {
      fail(`every table in public is granted to ${ROLE} — the allowlist is not an allowlist`);
    }
    await mustFail(
      `read non-allowlisted table ${outsider.t}`,
      `SELECT * FROM public.${probe.escapeIdentifier(outsider.t)} LIMIT 1`
    );
    await probe.query('ROLLBACK');

    console.log('');
    console.log(`  authentication as ${target.user}`);
    console.log(`    connected     : yes (session role ${who.current_user})`);
    console.log(`    BYPASSRLS     : ${who.bypassrls}`);
    console.log(`    SUPERUSER     : ${who.super}`);
    console.log(`    CREATE public : ${who.create_on_public}`);
    console.log('');
    console.log('  forbidden operations, attempted and refused');
    for (const d of denied) console.log(`    ${d}`);
    console.log('');
    if (NEEDS_ENCODING) {
      console.log('  NOTE: the password contains characters significant in a URL.');
      console.log('        Percent-encode it in PLATFORM_DATABASE_URL, or regenerate it');
      console.log('        using only letters, digits, - . _ ~');
    }
    console.log(`  PLATFORM_DATABASE_URL user is "${target.user}" — password not shown.`);
  } catch (e) {
    console.error('');
    console.error(`✗ ${ROLE} could not authenticate: ${e.message}`);
    console.error(`  The password IS set. What failed is the login as ${target.user}.`);
    process.exit(1);
  } finally {
    await probe.end().catch(() => {});
  }
})().catch((e) => {
  // Message only: a stack or a pg error object can carry the connection string.
  console.error('✗ provisioning failed:', e.message);
  process.exit(1);
});
