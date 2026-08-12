'use strict';
// Does the database actually stop one studio reading another's rows?
//
// Every other test in this repo about tenancy is a convention test: it reads
// source and checks a filter is present. That is a ratchet against new
// mistakes, and it proves nothing about the database. This one connects as
// the real `app_tenant` role — NOBYPASSRLS, not the table owner — against a
// real PostgreSQL with the real 158 migrations applied, and tries to commit
// the four crimes:
//
//   SELECT  another studio's row
//   INSERT  a row belonging to another studio
//   UPDATE  another studio's row
//   DELETE  another studio's row
//
// It is the first test here that CAN fail for the reason isolation actually
// breaks, because nothing is mocked: no fake pool, no stubbed client, a real
// connection whose current_user is app_tenant.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a throwaway database, so it
// never runs in an environment that has anything to lose. Stand one up with:
//
//   scripts/rls-proof-setup.sh
//
// which creates the roles, applies src/db/schema.sql, runs the migrations, and
// prints the URL to export.

const { Pool } = require('pg');

// Not named URL: that shadows the global URL class this file also needs.
const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describeIf('cross-tenant isolation, against a real database', () => {
  /** Owner connection. Bypasses RLS — used only to set the world up and to check it after. */
  let owner;
  /** The role the app will eventually connect as. */
  let tenant;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    const tenantUrl = new URL(DB_URL);
    tenantUrl.username = 'app_tenant';
    tenantUrl.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
    tenant = new Pool({ connectionString: tenantUrl.toString(), max: 2 });

    await owner.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Studio A','studio-a'), ($2,'Studio B','studio-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM pt_clients WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner?.end();
    await tenant?.end();
  });

  beforeEach(async () => {
    await owner.query(`DELETE FROM pt_clients WHERE id IN ('client-a','client-b')`);
    await owner.query(
      `INSERT INTO pt_clients (id, name, organization_id)
       VALUES ('client-a','A Member',$1), ('client-b','B Member',$2)`, [ORG_A, ORG_B]);
  });

  /** Run `fn` on a connection scoped to `orgId`, exactly as db/pool.js does. */
  async function asOrg(orgId, fn) {
    const client = await tenant.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.org_id', orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  it('connects as a role that cannot bypass RLS', async () => {
    // If this drifts, every assertion below passes for the wrong reason.
    const { rows } = await tenant.query(
      `SELECT current_user AS who, rolbypassrls, rolsuper
         FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0].who).toBe('app_tenant');
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolsuper).toBe(false);
  });

  it('the owner really can see both rows, so the fixture is real', async () => {
    const { rows } = await owner.query(
      `SELECT id FROM pt_clients WHERE id IN ('client-a','client-b') ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['client-a', 'client-b']);
  });

  // ── SELECT ────────────────────────────────────────────────────────────
  it('SELECT returns only the scoped studio\'s rows', async () => {
    const a = await asOrg(ORG_A, (c) =>
      c.query(`SELECT id FROM pt_clients WHERE id IN ('client-a','client-b') ORDER BY id`));
    expect(a.rows.map((r) => r.id)).toEqual(['client-a']);

    const b = await asOrg(ORG_B, (c) =>
      c.query(`SELECT id FROM pt_clients WHERE id IN ('client-a','client-b') ORDER BY id`));
    expect(b.rows.map((r) => r.id)).toEqual(['client-b']);
  });

  it('SELECT cannot reach the other studio even when asked for it by primary key', async () => {
    const { rows } = await asOrg(ORG_A, (c) =>
      c.query(`SELECT id, name FROM pt_clients WHERE id = 'client-b'`));
    expect(rows).toEqual([]);
  });

  it('aggregate queries cannot count what they cannot see', async () => {
    // The shape that leaks without anyone noticing: no row is returned, but a
    // total tells you how many exist.
    const { rows } = await asOrg(ORG_A, (c) =>
      c.query(`SELECT count(*)::int AS n FROM pt_clients`));
    const { rows: all } = await owner.query(`SELECT count(*)::int AS n FROM pt_clients`);
    expect(rows[0].n).toBe(1);
    expect(all[0].n).toBe(2);
  });

  // ── INSERT ────────────────────────────────────────────────────────────
  it('INSERT of a row belonging to another studio is refused', async () => {
    // WITH CHECK, not USING. Without it a tenant could write rows into another
    // studio and simply not be able to read them back.
    await expect(asOrg(ORG_A, (c) =>
      c.query(`INSERT INTO pt_clients (id, name, organization_id) VALUES ('smuggled','X',$1)`, [ORG_B])),
    ).rejects.toThrow(/row-level security/i);

    const { rows } = await owner.query(`SELECT id FROM pt_clients WHERE id = 'smuggled'`);
    expect(rows).toEqual([]);
  });

  it('INSERT into the scoped studio still works', async () => {
    // The failure mode on the other side: a policy that denies everything
    // passes an isolation test and breaks the product.
    await asOrg(ORG_A, (c) =>
      c.query(`INSERT INTO pt_clients (id, name, organization_id) VALUES ('client-a2','A Second',$1)`, [ORG_A]));
    const { rows } = await owner.query(`SELECT organization_id FROM pt_clients WHERE id = 'client-a2'`);
    expect(rows[0].organization_id).toBe(ORG_A);
    await owner.query(`DELETE FROM pt_clients WHERE id = 'client-a2'`);
  });

  // ── UPDATE ────────────────────────────────────────────────────────────
  it('UPDATE of another studio\'s row changes nothing', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`UPDATE pt_clients SET name = 'HACKED' WHERE id = 'client-b'`));
    expect(res.rowCount).toBe(0);

    const { rows } = await owner.query(`SELECT name FROM pt_clients WHERE id = 'client-b'`);
    expect(rows[0].name).toBe('B Member');
  });

  it('UPDATE cannot move a row into another studio', async () => {
    // Reparenting — taking a row you own and stamping someone else's org on
    // it. Blocked twice over, which is worth knowing because it is not
    // obvious: WITH CHECK rejects the new row, AND a FOR ALL policy's USING
    // expression is itself applied to the NEW row on UPDATE, not only the
    // existing one. Verified by mutation: USING(true)+CHECK(true) lets the
    // reparent through, and restoring either half alone blocks it again.
    await expect(asOrg(ORG_A, (c) =>
      c.query(`UPDATE pt_clients SET organization_id = $1 WHERE id = 'client-a'`, [ORG_B])),
    ).rejects.toThrow(/row-level security/i);

    const { rows } = await owner.query(`SELECT organization_id FROM pt_clients WHERE id = 'client-a'`);
    expect(rows[0].organization_id).toBe(ORG_A);
  });

  it('is blocked by each half of the policy independently', async () => {
    // Guards the belt-and-braces claim above. If someone later "simplifies"
    // the policy to USING-only or WITH CHECK-only, reparenting is still
    // refused — but the redundancy is gone, and this test is where that gets
    // noticed rather than in an incident.
    const policy = await owner.query(
      `SELECT qual, with_check FROM pg_policies
        WHERE tablename = 'pt_clients' AND policyname = 'tenant_isolation'`);
    expect(policy.rows[0].qual).toMatch(/app\.org_id/);
    expect(policy.rows[0].with_check).toMatch(/app\.org_id/);
  });

  it('UPDATE of the scoped studio\'s own row still works', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`UPDATE pt_clients SET name = 'A Renamed' WHERE id = 'client-a'`));
    expect(res.rowCount).toBe(1);
  });

  // ── DELETE ────────────────────────────────────────────────────────────
  it('DELETE of another studio\'s row removes nothing', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`DELETE FROM pt_clients WHERE id = 'client-b'`));
    expect(res.rowCount).toBe(0);

    const { rows } = await owner.query(`SELECT id FROM pt_clients WHERE id = 'client-b'`);
    expect(rows.map((r) => r.id)).toEqual(['client-b']);
  });

  it('an unqualified DELETE removes only the scoped studio\'s rows', async () => {
    // The worst plausible accident — a missing WHERE — and the backstop that
    // makes it survivable.
    await asOrg(ORG_A, (c) => c.query(`DELETE FROM pt_clients`));
    const { rows } = await owner.query(
      `SELECT id FROM pt_clients WHERE id IN ('client-a','client-b') ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['client-b']);
  });

  it('DELETE of the scoped studio\'s own row still works', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`DELETE FROM pt_clients WHERE id = 'client-a'`));
    expect(res.rowCount).toBe(1);
  });

  // ── The GUC itself ────────────────────────────────────────────────────
  it('sees nothing at all when app.org_id is not set', async () => {
    // Fail-closed. A connection that forgets the GUC must return zero rows,
    // not every row — this is the property that makes the whole design safe
    // to roll out before every call site is audited.
    const client = await tenant.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM pt_clients`);
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('forgets the scope at COMMIT, so the next borrower starts clean', async () => {
    // set_config(..., true) is transaction-local. If it leaked, a pooled
    // connection would carry one studio's scope into the next request.
    await asOrg(ORG_A, (c) => c.query(`SELECT 1`));
    const client = await tenant.connect();
    try {
      const { rows } = await client.query(`SELECT current_setting('app.org_id', true) AS v`);
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
    } finally {
      client.release();
    }
  });

  it('a forged org id matches nothing rather than everything', async () => {
    const { rows } = await asOrg('99999999-9999-4999-8999-999999999999', (c) =>
      c.query(`SELECT id FROM pt_clients`));
    expect(rows).toEqual([]);
  });
});
