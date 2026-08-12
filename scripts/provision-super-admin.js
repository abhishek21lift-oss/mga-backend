#!/usr/bin/env node
'use strict';
/**
 * One-time bootstrap: hand the platform super-admin account to a new operator.
 *
 * A freshly bootstrapped database contains exactly one account —
 * usr-superadmin-001, seeded by migration 091 and re-addressed by
 * 131_rename_platform_super_admin. Both carry a bcrypt hash in the migration
 * text whose plaintext, as 091's own comment says, "was delivered out-of-band
 * and is not in git". On a database for a different product that credential
 * belongs to nobody, and organisation creation is super-admin-only, so nothing
 * can be onboarded until this account has an owner.
 *
 * This script is the bridge. It is deliberately not a migration: a migration
 * would put a credential into version control forever, which is the problem
 * being fixed rather than a way to fix it.
 *
 * Both values come from the environment and neither is ever printed:
 *
 *   MY_GYM_AGENT_SUPER_ADMIN_EMAIL
 *   MY_GYM_AGENT_SUPER_ADMIN_PASSWORD
 *   MIGRATION_DATABASE_URL   (or DATABASE_URL) — a role that may UPDATE users
 *
 * Usage (do not put the password in shell history — read it from a prompt or a
 * secrets manager and export it for one command):
 *
 *   MY_GYM_AGENT_SUPER_ADMIN_EMAIL=ops@example.com \
 *   MY_GYM_AGENT_SUPER_ADMIN_PASSWORD="$(read -rs -p 'password: ' p; echo "$p")" \
 *   MIGRATION_DATABASE_URL=... node scripts/provision-super-admin.js
 */

const bcrypt = require('bcryptjs');           // the app's own dependency
const { Client } = require('pg');

const SUPER_ADMIN_ID = 'usr-superadmin-001';
const BCRYPT_COST = 12;                        // matches routes/auth.js
const MIN_PASSWORD_LENGTH = 12;

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const email = (process.env.MY_GYM_AGENT_SUPER_ADMIN_EMAIL || '').trim();
const password = process.env.MY_GYM_AGENT_SUPER_ADMIN_PASSWORD || '';
const dbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '';

if (!dbUrl) fail('MIGRATION_DATABASE_URL (or DATABASE_URL) must be set');
if (!email) fail('MY_GYM_AGENT_SUPER_ADMIN_EMAIL must be set');
// Deliberately simple: the address has to be routable, and this is an operator
// typing their own, not untrusted input needing an RFC-complete parser.
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('MY_GYM_AGENT_SUPER_ADMIN_EMAIL is not a valid address');
if (!password) fail('MY_GYM_AGENT_SUPER_ADMIN_PASSWORD must be set and non-empty');
if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`MY_GYM_AGENT_SUPER_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}
// This account can reach every tenant on the platform. A password that is
// merely long is not the bar worth setting for it.
if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
  fail('MY_GYM_AGENT_SUPER_ADMIN_PASSWORD must contain lower case, upper case and a digit');
}

(async () => {
  const client = new Client({
    connectionString: dbUrl,
    ssl: /sslmode=disable/.test(dbUrl) ? false : { rejectUnauthorized: false },
    statement_timeout: 30_000,
  });
  await client.connect();

  try {
    const { rows: before } = await client.query(
      `SELECT id, email, role, is_active, token_version, organization_id
         FROM users WHERE id = $1`, [SUPER_ADMIN_ID]
    );
    if (before.length !== 1) fail(`expected exactly one ${SUPER_ADMIN_ID}, found ${before.length}`);
    const prior = before[0];
    if (prior.role !== 'super_admin') fail(`${SUPER_ADMIN_ID} has role ${prior.role}, refusing to touch it`);

    // Refuse to collide with a different account rather than violate the
    // UNIQUE(email) constraint halfway through and leave a confusing error.
    const { rows: clash } = await client.query(
      `SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2`, [email, SUPER_ADMIN_ID]
    );
    if (clash.length) fail(`that address already belongs to another account (${clash[0].id})`);

    const hash = await bcrypt.hash(password, BCRYPT_COST);

    // Guarded on role as well as id: this statement must never be able to
    // re-address an ordinary user, whatever id is passed.
    const res = await client.query(
      `UPDATE users
          SET email         = $2,
              password      = $3,
              token_version = token_version + 1,
              updated_at    = NOW()
        WHERE id = $1 AND role = 'super_admin'
        RETURNING id, email, role, is_active, token_version,
                  organization_id IS NULL AS org_less`,
      [SUPER_ADMIN_ID, email, hash]
    );
    if (res.rowCount !== 1) fail(`expected exactly 1 row updated, got ${res.rowCount}`);
    const after = res.rows[0];

    // Invariants that must survive: this is a platform account, not a tenant's.
    if (after.role !== 'super_admin') fail('role changed — aborting');
    if (!after.org_less) fail('organization_id is no longer NULL — aborting');
    if (!after.is_active) fail('account is not active — aborting');
    if (after.token_version !== prior.token_version + 1) fail('token_version did not increment');

    // Nothing below prints the password, the hash, or the connection string.
    console.log('✓ platform super admin provisioned');
    console.log(`  id             : ${after.id}`);
    console.log(`  email          : ${after.email}`);
    console.log(`  role           : ${after.role}`);
    console.log(`  organization_id: NULL`);
    console.log(`  is_active      : ${after.is_active}`);
    console.log(`  token_version  : ${prior.token_version} → ${after.token_version} (existing sessions invalidated)`);
    console.log(`  password       : rotated, bcrypt cost ${BCRYPT_COST} (not shown)`);
  } finally {
    await client.end();
  }
})().catch((e) => {
  // Message only: a stack or a pg error object can carry the connection string.
  console.error('✗ provisioning failed:', e.message);
  process.exit(1);
});
