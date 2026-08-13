#!/usr/bin/env node
'use strict';
/**
 * Prove the HTTP layer keeps tenants apart, not just the database.
 *
 * RLS passing does not make the API safe. A route can read the database with
 * a service path, cache a response, aggregate without a tenant filter, or
 * simply trust an id from the URL — none of which the database-level suite
 * can see. This drives the real Express app through supertest with real
 * tokens minted by the real login route, so every request travels the actual
 * middleware chain: auth → tenant resolution → authorization → RLS.
 *
 * Runs against app_tenant with TENANT_RLS_ENFORCE=on, because testing the
 * API on a bypass-capable role would prove only that the controllers behave
 * when the database is not enforcing anything.
 *
 * Usage: ADMIN_URL=… API_IDOR_DB=… node scripts/api-idor-verify.js
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const ADMIN_URL = process.env.ADMIN_URL;
if (!ADMIN_URL) { console.error('ADMIN_URL must be set'); process.exit(2); }

let failures = 0;
const transcript = [];
const emit = (l) => { transcript.push(l); console.log(l); };
const head = (t) => emit(`\n=== ${t} ===`);
const note = (l) => {
  emit(`  NOTE  ${l}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=API IDOR::${l}`);
};

/**
 * Every assertion prints route, method, expectation and what actually
 * happened. "Process exited 1" is not a security finding; "GET /api/clients/:id
 * as tenant A returned tenant B's row" is.
 */
function check({ method, route, scenario, expected, actual, pass }) {
  const line = `  ${pass ? 'PASS' : 'FAIL'}  ${method.padEnd(6)} ${route.padEnd(38)} ${scenario} | expected ${expected} | actual ${actual}`;
  emit(line);
  if (!pass) {
    failures++;
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=API IDOR::${method} ${route} — ${scenario}: expected ${expected}, got ${actual}`);
    }
  }
}

process.on('exit', () => {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try {
    require('node:fs').appendFileSync(f, ['## API IDOR', '',
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

(async () => {
  const DB = process.env.API_IDOR_DB || 'mga_rls_test';
  const admin = new Client({ connectionString: urlFor(DB) });
  await admin.connect();

  head('SETUP — two tenants, two real users');
  const run = crypto.randomBytes(3).toString('hex');
  const pw = crypto.randomBytes(12).toString('hex') + 'Aa1!';
  const hash = await bcrypt.hash(pw, 10);

  const mkOrg = async (name, slug) =>
    (await admin.query(
      `INSERT INTO organizations (name, slug, status) VALUES ($1,$2,'active') RETURNING id`,
      [name, slug])).rows[0].id;
  // Synthetic names only. The old-brand string that used to be here is
  // exactly what must never appear in this product's data.
  const A = await mkOrg('Test Gym A', `idor-a-${run}`);
  const B = await mkOrg('Test Gym B', `idor-b-${run}`);

  // Same role for both, so any difference is tenancy and not privilege.
  const mkUser = async (orgId, tag) => {
    const email = `idor-${tag}-${run}@example.test`;
    const { rows } = await admin.query(
      `INSERT INTO users (name, email, password, role, organization_id, is_active)
       VALUES ($1,$2,$3,'admin',$4,TRUE) RETURNING id`,
      [`IDOR ${tag}`, email, hash, orgId]);
    return { id: rows[0].id, email };
  };
  const userA = await mkUser(A, 'a');
  const userB = await mkUser(B, 'b');
  emit(`  tenant A ${A}  user ${userA.email}`);
  emit(`  tenant B ${B}  user ${userB.email}`);

  // A tenant-owned record in each org, created as the owner so the fixture
  // itself is not what is under test.
  const mkClient = async (orgId, name) => {
    const { rows } = await admin.query(
      `INSERT INTO pt_clients (name, mobile, organization_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [name, '9' + Math.floor(100000000 + Math.random() * 899999999), orgId]);
    return rows[0].id;
  };
  const clientA = await mkClient(A, `A Client ${run}`);
  const clientB = await mkClient(B, `B Client ${run}`);
  emit(`  client A ${clientA}`);
  emit(`  client B ${clientB}`);
  await admin.end();

  // The app is required only now: it runs migrations on require, and it must
  // see the same DATABASE_URL the assertions will run under.
  const request = require('supertest');
  const app = require('../src/server.js');

  const login = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: pw });
    return { status: res.status, token: res.body && (res.body.token || res.body.accessToken) };
  };

  head('STEP 4 — authentication baseline');
  const sessA = await login(userA.email);
  const sessB = await login(userB.email);
  check({ method: 'POST', route: '/api/auth/login', scenario: 'user A signs in',
    expected: '200 + token', actual: `${sessA.status}${sessA.token ? ' + token' : ' + NO token'}`,
    pass: sessA.status === 200 && !!sessA.token });
  check({ method: 'POST', route: '/api/auth/login', scenario: 'user B signs in',
    expected: '200 + token', actual: `${sessB.status}${sessB.token ? ' + token' : ' + NO token'}`,
    pass: sessB.status === 200 && !!sessB.token });
  if (!sessA.token || !sessB.token) {
    note('cannot continue without both sessions — the rest of the suite would report false passes');
    emit(`\n  ${failures} check(s) FAILED`);
    process.exit(1);
  }
  const asA = (r) => r.set('Authorization', `Bearer ${sessA.token}`);
  const asB = (r) => r.set('Authorization', `Bearer ${sessB.token}`);

  const DENY = (s) => s === 403 || s === 404 || s === 400;

  // A token that logs in but is rejected on every later request would make
  // this entire suite pass for the wrong reason: 401 counts as "denied", so
  // every IDOR assertion would be satisfied by a session that simply does not
  // work. That happened — the middleware re-reads the user per request and
  // RLS hid it — and every check reported PASS while testing nothing.
  //
  // So: prove the session can reach its OWN tenant's data first. If it
  // cannot, the run is not evidence of isolation and stops here.
  {
    const own = await asA(request(app).get(`/api/clients/${clientA}`));
    const reachesOwn = own.status === 200;
    check({ method: 'GET', route: '/api/clients/:idOfA', scenario: 'A reads its OWN client (suite validity check)',
      expected: '200', actual: String(own.status), pass: reachesOwn });
    if (!reachesOwn) {
      note('the session cannot reach its own tenant, so every "denied" below would be meaningless — stopping');
      emit(`\n  ${failures} check(s) FAILED`);
      process.exit(1);
    }
  }

  head('STEP 5 — resource IDOR (GET by another tenant id)');
  for (const [label, path] of [
    ['client', `/api/clients/${clientB}`],
    ['client attendance', `/api/clients/${clientB}/attendance`],
    ['client payments', `/api/clients/${clientB}/payments`],
  ]) {
    const res = await asA(request(app).get(path));
    const leaked = JSON.stringify(res.body || '').includes(`B Client ${run}`);
    check({ method: 'GET', route: path.replace(clientB, ':idOfB'), scenario: `A reads B's ${label}`,
      expected: 'denied or empty', actual: `${res.status}${leaked ? ' LEAKED B DATA' : ''}`,
      pass: DENY(res.status) || !leaked });
  }

  head('STEP 6/7 — UPDATE and DELETE IDOR');
  {
    const before = await (async () => {
      const c = new Client({ connectionString: urlFor(DB) }); await c.connect();
      const r = await c.query('SELECT name FROM pt_clients WHERE id=$1', [clientB]); await c.end();
      return r.rows[0] && r.rows[0].name;
    })();
    const upd = await asA(request(app).put(`/api/clients/${clientB}`).send({ name: 'HIJACKED BY A' }));
    const after = await (async () => {
      const c = new Client({ connectionString: urlFor(DB) }); await c.connect();
      const r = await c.query('SELECT name FROM pt_clients WHERE id=$1', [clientB]); await c.end();
      return r.rows[0] && r.rows[0].name;
    })();
    check({ method: 'PUT', route: '/api/clients/:idOfB', scenario: "A updates B's client",
      expected: 'denied AND row unchanged', actual: `${upd.status}, name ${after === before ? 'unchanged' : 'CHANGED'}`,
      pass: after === before });

    const del = await asA(request(app).delete(`/api/clients/${clientB}`));
    const stillThere = await (async () => {
      const c = new Client({ connectionString: urlFor(DB) }); await c.connect();
      const r = await c.query('SELECT count(*)::int n FROM pt_clients WHERE id=$1', [clientB]); await c.end();
      return r.rows[0].n === 1;
    })();
    check({ method: 'DELETE', route: '/api/clients/:idOfB', scenario: "A deletes B's client",
      expected: 'denied AND row survives', actual: `${del.status}, row ${stillThere ? 'survives' : 'GONE'}`,
      pass: stillThere });
  }

  head('STEP 8 — create with a forged organization_id');
  {
    const name = `Forged ${run}`;
    const res = await asA(request(app).post('/api/clients')
      .send({ name, mobile: '9' + Math.floor(100000000 + Math.random() * 899999999), organization_id: B }));
    const c = new Client({ connectionString: urlFor(DB) }); await c.connect();
    const { rows } = await c.query('SELECT organization_id FROM pt_clients WHERE name=$1', [name]);
    await c.end();
    const landedInB = rows.some((r) => r.organization_id === B);
    check({ method: 'POST', route: '/api/clients', scenario: 'A creates claiming organization_id = B',
      expected: 'row belongs to A, or rejected', actual: `${res.status}, rows in B: ${landedInB ? 'YES' : 'none'}`,
      pass: !landedInB });
  }

  head('STEP 11/12 — collection and search isolation');
  for (const [label, path] of [
    ['clients list', '/api/clients'],
    ['clients paginated', '/api/clients?page=1&limit=100'],
    ['clients search by B name', `/api/clients?search=B%20Client%20${run}`],
    ['payments list', '/api/payments'],
    ['attendance list', '/api/attendance'],
  ]) {
    const res = await asA(request(app).get(path));
    const body = JSON.stringify(res.body || '');
    const leaked = body.includes(`B Client ${run}`) || body.includes(clientB);
    check({ method: 'GET', route: path, scenario: `A lists — ${label}`,
      expected: 'no tenant B rows', actual: `${res.status}${leaked ? ' LEAKED B DATA' : ' clean'}`,
      pass: !leaked });
  }

  head('STEP 10 — query-parameter IDOR');
  for (const [label, path] of [
    ['organization_id=B', `/api/clients?organization_id=${B}`],
    ['client_id=B', `/api/attendance?client_id=${clientB}`],
  ]) {
    const res = await asA(request(app).get(path));
    const body = JSON.stringify(res.body || '');
    const leaked = body.includes(`B Client ${run}`) || body.includes(clientB);
    check({ method: 'GET', route: path.split('?')[0] + '?' + label, scenario: 'A supplies a B identifier',
      expected: 'no tenant B rows', actual: `${res.status}${leaked ? ' LEAKED B DATA' : ' clean'}`,
      pass: !leaked });
  }

  head('STEP 15 — analytics and reports isolation');
  for (const path of ['/api/reports/summary', '/api/reports/revenue', '/api/dashboard', '/api/reports']) {
    const res = await asA(request(app).get(path));
    if (res.status === 404) continue;   // route does not exist; not a finding
    const body = JSON.stringify(res.body || '');
    const leaked = body.includes(`B Client ${run}`) || body.includes(clientB);
    check({ method: 'GET', route: path, scenario: 'A reads aggregates',
      expected: 'no tenant B identifiers', actual: `${res.status}${leaked ? ' LEAKED B DATA' : ' clean'}`,
      pass: !leaked });
  }

  // ── Exports and generated documents ────────────────────────────────────
  //
  // Phase 5K. An export is the one place where a tenant's data leaves the
  // database as a file, so an authorisation slip here is not "one row" — it is
  // the whole table, in a format built for taking away. These endpoints stream
  // a PDF or CSV rather than JSON, which also means a leak would not be caught
  // by any assertion that inspects res.body.
  head('STEP 17 — exports and generated documents');
  {
    // The validity gate first, exactly as everywhere else in this file: prove
    // A can export its OWN client before trusting any refusal. Without this a
    // broken route returns 404 to everyone and every denial below is vacuous.
    const own = await asA(request(app).get(`/api/pt-os/clients/${clientA}/enrollment-pdf`));
    const ownWorks = own.status === 200;
    check({ method: 'GET', route: '/api/pt-os/clients/:id/enrollment-pdf',
      scenario: 'A exports its OWN client (validity gate)',
      expected: '200 — otherwise the denials below prove nothing',
      actual: String(own.status), pass: ownWorks });

    if (ownWorks) {
      const cross = await asA(request(app).get(`/api/pt-os/clients/${clientB}/enrollment-pdf`));
      // A PDF is bytes, not JSON: check the payload itself for B's name, so a
      // 200 carrying B's data cannot pass as success.
      const bytes = Buffer.isBuffer(cross.body) ? cross.body.toString('latin1')
        : JSON.stringify(cross.body || '') + String(cross.text || '');
      const leaked = bytes.includes(`B Client ${run}`);
      check({ method: 'GET', route: '/api/pt-os/clients/:idOfB/enrollment-pdf',
        scenario: "A exports B's client as a PDF",
        expected: 'denied or empty, and no B identifiers in the bytes',
        actual: `${cross.status}${leaked ? ' LEAKED B DATA' : ' clean'}`,
        pass: !leaked && cross.status !== 200 });
    }

    // Receipts are generated from a payment order. The order lookup is the
    // authorisation point; everything downstream is derived from that row.
    for (const path of [`/api/payments/upi/${clientB}/receipt`]) {
      const res = await asA(request(app).get(path));
      if (res.status === 404 || res.status === 400) {
        check({ method: 'GET', route: '/api/payments/upi/:idOfB/receipt',
          scenario: 'A downloads a receipt scoped to B',
          expected: 'not found for A', actual: String(res.status), pass: true });
        continue;
      }
      const bytes = Buffer.isBuffer(res.body) ? res.body.toString('latin1')
        : JSON.stringify(res.body || '') + String(res.text || '');
      check({ method: 'GET', route: '/api/payments/upi/:idOfB/receipt',
        scenario: 'A downloads a receipt scoped to B',
        expected: 'denied, and no B identifiers in the bytes',
        actual: `${res.status}${bytes.includes(`B Client ${run}`) ? ' LEAKED B DATA' : ' clean'}`,
        pass: !bytes.includes(`B Client ${run}`) && res.status !== 200 });
    }

    // Platform exports: a tenant admin must not reach the CSV that spans every
    // organisation on the platform.
    for (const path of ['/api/super-admin/billing/invoices.csv',
                        '/api/super-admin/operations/audit-log.csv']) {
      const res = await asA(request(app).get(path));
      if (res.status === 404) continue;
      check({ method: 'GET', route: path, scenario: 'tenant admin reaches a platform export',
        expected: '401/403', actual: String(res.status),
        pass: res.status === 401 || res.status === 403 });
    }
  }

  // ── Gateway transactions (Phase 6H-B2) ────────────────────────────────
  //
  // The Razorpay callback is unauthenticated, so it cannot carry a tenant and
  // must not be able to choose one. gateway_record_event resolves the
  // organisation from the row a trusted path created; these assertions run the
  // function as app_tenant, the same role the webhook uses, against two real
  // organisations.
  head('STEP 30 — gateway transaction tenant safety');
  {
    // Its own privileged client: the harness closes `admin` once the fixtures
    // are built, well before this step runs.
    const seed = new Client({ connectionString: urlFor(DB) });
    await seed.connect();
    const g = new Client({ connectionString: process.env.DATABASE_URL });
    await g.connect();
    try {
      const payA = `pay_A_${run}`;
      const payB = `pay_B_${run}`;
      for (const [org, pid] of [[A, payA], [B, payB]]) {
        await seed.query(
          `INSERT INTO gateway_transactions (organization_id, provider, provider_payment_id, amount)
           VALUES ($1,'razorpay',$2,100) ON CONFLICT DO NOTHING`, [org, pid]);
      }
      const rec = (pid, ev) => g.query(
        "SELECT * FROM gateway_record_event('razorpay',$1,$2,'captured','{}'::jsonb)", [pid, ev]);

      const a1 = (await rec(payA, `evt_a_${run}`)).rows[0];
      check({ method: 'FN', route: 'gateway_record_event', scenario: "A's event resolves A",
        expected: `applied + org ${A}`, actual: `applied=${a1.applied} org=${a1.organization_id}`,
        pass: a1.applied === true && a1.organization_id === A });

      // The property the whole design rests on: a provider id can only ever
      // reach the organisation that owns it.
      check({ method: 'FN', route: 'gateway_record_event', scenario: "A's event cannot resolve B",
        expected: `never org ${B}`, actual: String(a1.organization_id),
        pass: a1.organization_id !== B });

      const dup = (await rec(payA, `evt_a_${run}`)).rows[0];
      check({ method: 'FN', route: 'gateway_record_event', scenario: 'duplicate event id',
        expected: 'applied=false, no second mutation', actual: `applied=${dup.applied}`,
        pass: dup.applied === false });

      const unknown = (await rec(`pay_nope_${run}`, `evt_x_${run}`)).rows[0];
      check({ method: 'FN', route: 'gateway_record_event', scenario: 'unknown provider payment id',
        expected: 'fails closed, no tenant invented',
        actual: `applied=${unknown.applied} id=${unknown.transaction_id}`,
        pass: unknown.applied === false && unknown.transaction_id === null });

      const b1 = (await rec(payB, `evt_b_${run}`)).rows[0];
      check({ method: 'FN', route: 'gateway_record_event', scenario: "B's event resolves B",
        expected: `org ${B}`, actual: String(b1.organization_id), pass: b1.organization_id === B });

      const { rows: [bRow] } = await seed.query(
        'SELECT last_event_id FROM gateway_transactions WHERE provider_payment_id = $1', [payB]);
      check({ method: 'FN', route: 'gateway_transactions', scenario: "B's row after all A traffic",
        expected: 'untouched by A', actual: String(bRow.last_event_id),
        pass: bRow.last_event_id === `evt_b_${run}` });

      const { rows: [dupes] } = await seed.query(
        'SELECT count(*)::int AS n FROM gateway_transactions WHERE provider_payment_id = $1', [payA]);
      check({ method: 'FN', route: 'gateway_transactions', scenario: 'replay creates no second row',
        expected: '1', actual: String(dupes.n), pass: dupes.n === 1 });

      const { rows: [vis] } = await g.query('SELECT count(*)::int AS n FROM gateway_transactions');
      check({ method: 'SELECT', route: 'gateway_transactions', scenario: 'app_tenant reads without tenant context',
        expected: '0 rows — RLS strict', actual: String(vis.n), pass: vis.n === 0 });
    } finally {
      await g.end();
      await seed.end();
    }
  }

  head('STEP 20 — super-admin routes refuse a tenant admin');
  for (const path of ['/api/admin/organizations', '/api/platform/organizations', '/api/admin/users']) {
    const res = await asA(request(app).get(path));
    if (res.status === 404) continue;
    check({ method: 'GET', route: path, scenario: 'tenant admin reaches platform surface',
      expected: '401/403', actual: String(res.status),
      pass: res.status === 401 || res.status === 403 });
  }

  head('STEP 25 — reverse direction, B → A');
  {
    const res = await asB(request(app).get(`/api/clients/${clientA}`));
    const leaked = JSON.stringify(res.body || '').includes(`A Client ${run}`);
    check({ method: 'GET', route: '/api/clients/:idOfA', scenario: "B reads A's client",
      expected: 'denied or empty', actual: `${res.status}${leaked ? ' LEAKED A DATA' : ''}`,
      pass: DENY(res.status) || !leaked });
    const list = await asB(request(app).get('/api/clients'));
    const leakedList = JSON.stringify(list.body || '').includes(`A Client ${run}`);
    check({ method: 'GET', route: '/api/clients', scenario: 'B lists clients',
      expected: 'no tenant A rows', actual: `${list.status}${leakedList ? ' LEAKED A DATA' : ' clean'}`,
      pass: !leakedList });
  }

  head('RESULT');
  if (failures) { emit(`  ${failures} check(s) FAILED`); process.exit(1); }
  emit('  all checks passed');
  process.exit(0);
})().catch((e) => {
  const detail = `${e.message}${e.code ? ` [${e.code}]` : ''}`;
  console.error('\nHARNESS ERROR:', detail);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=API IDOR harness::${detail}`);
  if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
