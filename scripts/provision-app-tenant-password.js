#!/usr/bin/env node
'use strict';
/**
 * One-time bootstrap: give the `app_tenant` role a password.
 *
 * Migration 157 creates app_tenant WITH LOGIN but deliberately never sets a
 * password — a password in a migration is a password in git forever. So the
 * role exists, is correctly de-privileged, and cannot actually log in. This
 * script closes that last gap so DATABASE_URL can point at it instead of at
 * `postgres`, which is what makes RLS load-bearing: postgres owns the tables
 * and every tenant_isolation policy is invisible to it.
 *
 * Changes exactly one thing — app_tenant's password. No grants, no policies,
 * no privilege flags, no other role.
 *
 *   APP_TENANT_PASSWORD       the new password (never printed, never stored)
 *   MIGRATION_DATABASE_URL    a role with ADMIN OPTION on app_tenant
 *
 * Usage (keep it out of shell history — read it, don't paste it):
 *
 *   APP_TENANT_PASSWORD="$(read -rs -p 'password: ' p; echo "$p")" \
 *   MIGRATION_DATABASE_URL=... node scripts/provision-app-tenant-password.js
 *
 * ── Why the password is hashed here and not by the server ────────────────
 *
 * ALTER ROLE ... PASSWORD is a utility statement, so it cannot take a bound
 * parameter — the value has to be part of the SQL text. Sent as plaintext it
 * would then appear in pg_stat_activity and in Supabase's Postgres logs, where
 * it outlives this process and is visible to anyone with dashboard access.
 *
 * Instead the SCRAM-SHA-256 verifier is computed locally and *that* is what
 * crosses the wire, so the plaintext never leaves this machine at all. This is
 * not a clever trick: it is precisely what psql's own \password command does,
 * for precisely this reason. The verifier is one-way, and it is never printed
 * either.
 */

const { Client } = require('pg');
// Shared with provision-app-platform-password.js: one SCRAM implementation to
// get right, not one per role. See scripts/lib/scram.js for why the hashing
// happens here rather than on the server.
const { scramVerifier, DEFAULT_ITERATIONS } = require('./lib/scram');

const ROLE = 'app_tenant';
const SCRAM_ITERATIONS = DEFAULT_ITERATIONS;
const MIN_PASSWORD_LENGTH = 16;

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const password = process.env.APP_TENANT_PASSWORD || '';
const dbUrl = process.env.MIGRATION_DATABASE_URL || '';

if (!dbUrl) fail('MIGRATION_DATABASE_URL must be set');
if (!password) fail('APP_TENANT_PASSWORD must be set and non-empty');
if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`APP_TENANT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}
// Printable ASCII only. Two reasons, both practical rather than pedantic:
// SCRAM requires SASLprep normalisation of non-ASCII input, which is a whole
// dependency and a whole class of "it works here but not there"; and this
// value has to survive being embedded in a URL and passed through Render,
// Vercel and a shell.
if (!/^[\x21-\x7e]+$/.test(password)) {
  fail('APP_TENANT_PASSWORD must be printable ASCII with no spaces');
}
// Note what is NOT enforced: character classes. This is a machine credential
// that no human types. Demanding "one digit, one symbol" of a 32-character
// random string would reject strong passwords for failing a rule designed for
// weak ones. Length is the property that matters here.

// Characters that change meaning inside a URL. Not fatal — they just have to
// be percent-encoded in DATABASE_URL, and the script prints the encoded form
// of the *username* only, never the password.
const NEEDS_ENCODING = /[:/?#[\]@%&=+$,; ]/.test(password);

const ssl = (u) => (/sslmode=disable/.test(u) ? false : { rejectUnauthorized: false });

/** Every role attribute that exists, so "nothing else moved" is checkable. */
const ROLE_CENSUS = `
  SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
         rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil,
         (rolpassword IS NOT NULL) AS has_password
    FROM pg_authid ORDER BY rolname`;

/** app_tenant's table privileges and every RLS policy in public. */
const GRANT_CENSUS = `
  SELECT (SELECT count(*) FROM information_schema.role_table_grants
           WHERE grantee = '${ROLE}')                                 AS table_grants,
         (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity) AS rls_tables,
         (SELECT md5(string_agg(table_name||':'||privilege_type, ',' ORDER BY table_name, privilege_type))
            FROM information_schema.role_table_grants WHERE grantee='${ROLE}') AS grant_fingerprint,
         (SELECT md5(string_agg(schemaname||'.'||tablename||':'||policyname, ',' ORDER BY schemaname, tablename, policyname))
            FROM pg_policies WHERE schemaname='public')               AS policy_fingerprint`;

const FLAGS = `
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin,
         has_schema_privilege($1,'public','CREATE') AS create_on_public,
         has_schema_privilege($1,'public','USAGE')  AS usage_on_public
    FROM pg_roles WHERE rolname = $1`;

/**
 * Derive app_tenant's connection URL from the privileged one, so the login
 * test exercises the same host, port and TLS the application will use.
 *
 * Supabase's pooler authenticates as "<role>.<project_ref>", which is why the
 * project ref is carried across rather than the username simply replaced.
 */
function deriveTenantUrl(privilegedUrl, plaintext) {
  const u = new URL(privilegedUrl);
  const dot = decodeURIComponent(u.username).indexOf('.');
  u.username = dot === -1 ? ROLE : `${ROLE}${decodeURIComponent(u.username).slice(dot)}`;
  u.password = plaintext;                 // URL setter percent-encodes for us
  return { url: u.toString(), user: u.username };
}

(async () => {
  const admin = new Client({ connectionString: dbUrl, ssl: ssl(dbUrl), statement_timeout: 30_000 });
  await admin.connect();

  let tenantUrl;
  let tenantUser;
  try {
    // ── Preconditions ────────────────────────────────────────────────────
    const { rows: exists } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    if (!exists.length) fail(`role ${ROLE} does not exist — run migration 157 first`);

    const { rows: [pre] } = await admin.query(FLAGS, [ROLE]);
    if (!pre.rolcanlogin) fail(`${ROLE} cannot log in; refusing to paper over that with a password`);

    // Refuse rather than fail halfway through: PostgreSQL 16 removed
    // CREATEROLE's blanket authority over other roles, so the privileged role
    // now needs ADMIN OPTION on app_tenant specifically. Supabase's `postgres`
    // is not a superuser, so this is a real check, not a formality.
    const { rows: [auth] } = await admin.query(`
      SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
             EXISTS (SELECT 1 FROM pg_auth_members m
                       JOIN pg_roles r ON r.oid = m.roleid
                       JOIN pg_roles g ON g.oid = m.member
                      WHERE r.rolname = $1 AND g.rolname = current_user
                        AND m.admin_option) AS has_admin`, [ROLE]);
    if (!auth.is_super && !auth.has_admin) {
      fail(`current role has neither SUPERUSER nor ADMIN OPTION on ${ROLE}; cannot set its password`);
    }

    // Baselines for the "nothing else changed" proof below.
    const rolesBefore = (await admin.query(ROLE_CENSUS)).rows;
    const { rows: [grantsBefore] } = await admin.query(GRANT_CENSUS);

    // ── The one change ───────────────────────────────────────────────────
    // Named explicitly, so no other role can be reached. PASSWORD alone — not
    // "WITH LOGIN PASSWORD" — so no attribute is restated and none can drift.
    const verifier = scramVerifier(password, SCRAM_ITERATIONS);
    await admin.query(`ALTER ROLE ${ROLE} WITH PASSWORD ${admin.escapeLiteral(verifier)}`);

    // ── Verify: the five flags, LOGIN, and CREATE on public ──────────────
    const { rows: [post] } = await admin.query(FLAGS, [ROLE]);
    const mustBeFalse = ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'];
    const raised = mustBeFalse.filter((f) => post[f] !== false);
    if (raised.length) fail(`${ROLE} gained privileges: ${raised.join(', ')}`);
    if (post.create_on_public !== false) fail(`${ROLE} now has CREATE on schema public`);
    if (post.rolcanlogin !== true) fail(`${ROLE} lost LOGIN`);
    if (post.usage_on_public !== true) fail(`${ROLE} lost USAGE on schema public`);

    // ── Verify: no grant and no policy moved ─────────────────────────────
    const { rows: [grantsAfter] } = await admin.query(GRANT_CENSUS);
    for (const k of ['table_grants', 'policies', 'rls_tables', 'grant_fingerprint', 'policy_fingerprint']) {
      if (String(grantsBefore[k]) !== String(grantsAfter[k])) fail(`${k} changed — aborting`);
    }

    // ── Verify: no other role was touched ────────────────────────────────
    // Every attribute of every role compared. app_tenant is allowed to differ
    // in exactly one field, has_password, and in nothing else.
    const rolesAfter = (await admin.query(ROLE_CENSUS)).rows;
    if (rolesBefore.length !== rolesAfter.length) fail('the set of roles changed — aborting');
    const key = (r) => JSON.stringify(r);
    const stripPw = (r) => { const c = { ...r }; delete c.has_password; return c; };
    for (let i = 0; i < rolesAfter.length; i += 1) {
      const [a, b] = [rolesBefore[i], rolesAfter[i]];
      if (a.rolname !== b.rolname) fail('role ordering changed — aborting');
      if (a.rolname === ROLE) {
        if (key(stripPw(a)) !== key(stripPw(b))) fail(`${ROLE} attributes changed beyond its password`);
      } else if (key(a) !== key(b)) {
        fail(`role ${b.rolname} was modified — aborting`);
      }
    }
    const selfBefore = rolesBefore.find((r) => r.rolname === ROLE);
    const selfAfter = rolesAfter.find((r) => r.rolname === ROLE);
    const wasReset = selfBefore.has_password && selfAfter.has_password;
    if (!selfAfter.has_password) fail('password did not take effect');

    tenantUrl = deriveTenantUrl(dbUrl, password);
    tenantUser = tenantUrl.user;

    console.log(`✓ ${ROLE} password ${wasReset ? 'rotated' : 'set'}`);
    console.log('');
    console.log('  privilege flags (all must be false)');
    for (const f of mustBeFalse) console.log(`    ${f.replace('rol', '').padEnd(12)}: ${post[f]}`);
    console.log(`    ${'LOGIN'.padEnd(12)}: ${post.rolcanlogin}   (required true)`);
    console.log(`    ${'CREATE public'.padEnd(12)}: ${post.create_on_public}   (required false)`);
    console.log('');
    console.log('  unchanged by this script');
    console.log(`    table grants to ${ROLE} : ${grantsAfter.table_grants} (fingerprint identical)`);
    console.log(`    RLS policies in public   : ${grantsAfter.policies} (fingerprint identical)`);
    console.log(`    tables with RLS enabled  : ${grantsAfter.rls_tables}`);
    console.log(`    other roles modified     : 0 of ${rolesAfter.length - 1}`);
  } finally {
    await admin.end();
  }

  // ── Verify: the role can actually authenticate ─────────────────────────
  // Over the same host, port and TLS the application will use, because a
  // password that works on a direct connection but not through the pooler is
  // not a password that works.
  const probe = new Client({
    connectionString: tenantUrl.url,
    ssl: ssl(tenantUrl.url),
    statement_timeout: 15_000,
    connectionTimeoutMillis: 20_000,
  });
  try {
    await probe.connect();
    const { rows: [who] } = await probe.query(`
      SELECT current_user,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
             has_schema_privilege(current_user,'public','CREATE') AS create_on_public`);
    if (who.current_user !== ROLE) fail(`authenticated, but as ${who.current_user} rather than ${ROLE}`);
    if (who.bypassrls !== false) fail('session role has BYPASSRLS');
    if (who.create_on_public !== false) fail('session role has CREATE on public');

    // The point of the whole exercise: RLS must actually bite on this session.
    // Without a tenant set, a tenant-scoped table must be empty rather than
    // readable. Proves the connection is genuinely subject to policy.
    let rlsProof = 'skipped (no tenant-scoped table found)';
    const { rows: probeTable } = await probe.query(`
      SELECT tablename FROM pg_policies
       WHERE schemaname='public' AND policyname='tenant_isolation'
       ORDER BY tablename LIMIT 1`);
    if (probeTable.length) {
      const t = probeTable[0].tablename;
      await probe.query('BEGIN');
      await probe.query("SELECT set_config('app.org_id', '00000000-0000-0000-0000-000000000000', true)");
      const { rows: [c] } = await probe.query(`SELECT count(*)::int AS n FROM public.${probe.escapeIdentifier(t)}`);
      await probe.query('ROLLBACK');
      rlsProof = c.n === 0
        ? `visible rows in ${t} for a non-existent tenant: 0 — RLS is in force`
        : `WARNING: ${c.n} rows visible in ${t} for a non-existent tenant`;
      if (c.n !== 0) fail(rlsProof);
    }

    console.log('');
    console.log(`  authentication as ${tenantUser}`);
    console.log(`    connected      : yes (session role ${who.current_user})`);
    console.log(`    BYPASSRLS      : ${who.bypassrls}`);
    console.log(`    CREATE public  : ${who.create_on_public}`);
    console.log(`    ${rlsProof}`);
    console.log('');
    if (NEEDS_ENCODING) {
      console.log('  NOTE: the password contains characters that are significant in a URL.');
      console.log('        Percent-encode it when building DATABASE_URL, or regenerate it');
      console.log('        using only letters, digits, - . _ ~ to avoid the problem.');
    }
    console.log(`  DATABASE_URL user is "${tenantUser}" — password not shown.`);
  } catch (e) {
    console.error('');
    console.error(`✗ ${ROLE} could not authenticate: ${e.message}`);
    console.error(`  The password IS set. What failed is the login attempt as ${tenantUser}.`);
    console.error('  Check that the host allows this role and that the pooler accepts it.');
    process.exit(1);
  } finally {
    await probe.end().catch(() => {});
  }
})().catch((e) => {
  // Message only: a stack or a pg error object can carry the connection string.
  console.error('✗ provisioning failed:', e.message);
  process.exit(1);
});
