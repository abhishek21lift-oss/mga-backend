// The 36 borrowed-client transactions get app.org_id too.
//
// pool.query's wrapper cannot reach them: those call sites do
// `pool.connect()` → `BEGIN` → several statements → `COMMIT`, and the GUC has
// to be set INSIDE that transaction, on that connection. Left alone, the day
// DATABASE_URL points at app_tenant every one of them — payments, invoices,
// enrolment — returns zero rows. Silently, because RLS filters rather than
// errors, so the symptom is an empty invoice list rather than a stack trace.
//
// These test scopeClient directly against a fake client. That is deliberate:
// the thing being verified is the ORDER and SCOPE of the statements it emits,
// which is exactly what a real database would hide behind a green result.

const { EventEmitter } = require('node:events');

// pool.js reads DATABASE_URL at require time and logs fatally without it.
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://u:p@localhost:5432/db?sslmode=disable';

const pool = require('../db/pool');
const { scopeClient } = pool;

/** Records every statement, in order, the way Postgres would receive them. */
function fakeClient() {
  const c = new EventEmitter();
  c.log = [];
  c.released = 0;
  c.query = jest.fn((...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    c.log.push([sql, args[1]]);
    return Promise.resolve({ rows: [] });
  });
  c.release = jest.fn(() => { c.released += 1; });
  return c;
}

const silent = { warn: jest.fn() };

beforeEach(() => { silent.warn.mockClear(); });

describe('scopeClient', () => {
  it('sets app.org_id immediately after the caller BEGINs', async () => {
    const c = fakeClient();
    const orig = c.query;
    scopeClient(c, 'org-a', silent);

    await c.query('BEGIN');

    expect(c.log.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
    ]);
    // Transaction-scoped (the third argument), so it cannot outlive the
    // transaction or leak to whoever borrows this connection next.
    expect(c.log[1][1]).toEqual(['app.org_id', 'org-a']);
    expect(c.query).not.toBe(orig);   // patched while borrowed
  });

  it('sets it BEFORE the caller runs any statement of its own', async () => {
    // The ordering is the whole point: a statement issued between BEGIN and
    // set_config runs with no org context and would see nothing under RLS.
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('BEGIN');
    await c.query('INSERT INTO pt_payments (amount) VALUES ($1)', [500]);

    expect(c.log.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'INSERT INTO pt_payments (amount) VALUES ($1)',
    ]);
  });

  it('binds the org id rather than building it into SQL text', async () => {
    // SET LOCAL does not accept a bind parameter, which is why this is
    // set_config(). String-building an org id into SQL is the injection shape
    // a scoping layer must not introduce.
    const c = fakeClient();
    scopeClient(c, "org'; DROP TABLE pt_clients; --", silent);

    await c.query('BEGIN');

    expect(c.log[1][0]).toBe('SELECT set_config($1, $2, true)');
    expect(c.log[1][1][1]).toBe("org'; DROP TABLE pt_clients; --");
    expect(c.log.map(([sql]) => sql).join(' ')).not.toMatch(/DROP TABLE/);
  });

  it('re-scopes a second transaction on the same client', async () => {
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('BEGIN');
    await c.query('COMMIT');
    await c.query('BEGIN');

    expect(c.log.map(([sql]) => sql)).toEqual([
      'BEGIN', 'SELECT set_config($1, $2, true)',
      'COMMIT',
      'BEGIN', 'SELECT set_config($1, $2, true)',
    ]);
  });

  it('treats ROLLBACK as ending the transaction', async () => {
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('BEGIN');
    await c.query('ROLLBACK');
    await c.query('SELECT 1');

    // The SELECT is outside a transaction now, so it warns rather than
    // pretending it is scoped.
    expect(silent.warn).toHaveBeenCalledTimes(1);
  });

  it('warns once, not per statement, about un-scoped work', async () => {
    // A borrowed client can take a session-level advisory lock outside any
    // transaction. Wrapping those in transactions would change locking
    // semantics, so they are reported instead — one line per borrow, so the
    // staging flag-on phase gets a list rather than a flood.
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('SELECT pg_advisory_lock($1)', [1]);
    await c.query('SELECT 1');
    await c.query('SELECT 2');

    expect(silent.warn).toHaveBeenCalledTimes(1);
    expect(silent.warn.mock.calls[0][1]).toMatch(/tenant_scope_gap/);
    expect(silent.warn.mock.calls[0][0].orgId).toBe('org-a');
  });

  it('does not warn about statements inside the transaction', async () => {
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('BEGIN');
    await c.query('SELECT 1');
    await c.query('UPDATE pt_payments SET amount = 1');
    await c.query('COMMIT');

    expect(silent.warn).not.toHaveBeenCalled();
  });

  it('unpatches on release, so a re-borrowed client is not double-wrapped', async () => {
    // The pool hands the same physical client out again. Without this the
    // wrapper would wrap the previous wrapper on every borrow and the stack
    // would grow for the life of the process.
    const c = fakeClient();
    const beforeQuery = c.query;
    const beforeRelease = c.release;

    scopeClient(c, 'org-a', silent);
    expect(c.query).not.toBe(beforeQuery);

    c.release();

    // The exact original references, not equivalent bound copies — otherwise
    // every borrow/release cycle adds a wrapper layer that never comes off.
    expect(c.query).toBe(beforeQuery);
    expect(c.release).toBe(beforeRelease);
    expect(c.released).toBe(1);
  });

  it('survives many borrow/release cycles without accumulating wrappers', async () => {
    const c = fakeClient();
    const beforeQuery = c.query;

    for (let i = 0; i < 50; i++) {
      scopeClient(c, `org-${i}`, silent);
      await c.query('BEGIN');
      await c.query('COMMIT');
      c.release();
      expect(c.query).toBe(beforeQuery);
    }
    // 50 cycles x (BEGIN + set_config + COMMIT), and nothing extra.
    expect(c.log).toHaveLength(150);
  });

  it('passes callback-style query straight through', async () => {
    // pg still supports it; nothing in this repo uses it, and a wrapper that
    // assumed a promise would break it silently.
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);
    const cb = jest.fn();

    c.query('SELECT 1', cb);

    expect(c.query).toBeDefined();
    expect(c.log.map(([sql]) => sql)).toEqual(['SELECT 1']);
  });

  it('recognises START TRANSACTION as well as BEGIN', async () => {
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);

    await c.query('start transaction');

    expect(c.log.map(([sql]) => sql)).toEqual([
      'start transaction',
      'SELECT set_config($1, $2, true)',
    ]);
  });
});

describe('the connect() wrapper is gated exactly like the query() one', () => {
  it('reads the same env var, so the two cannot disagree', () => {
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, '..', 'db', 'pool.js'), 'utf8');
    // One definition, both wrappers.
    expect(src.match(/TENANT_RLS_ENFORCE\s*=\s*process\.env/g)).toHaveLength(1);
    expect(src).toMatch(/pool\.connect = function tenantScopedConnect/);
    expect(src).toMatch(/if \(!TENANT_RLS_ENFORCE\) return borrowed;/);
  });

  it('is not stacked on top of pool.query, which scopes its own borrow', () => {
    // The hazard, demonstrated rather than asserted: withOrgScope issues
    // BEGIN + set_config itself. Run it against an ALREADY-scoped client and
    // the BEGIN interceptor fires too, so the same GUC is set twice — one
    // wasted round trip on every single query once the flag is on, and two
    // mechanisms responsible for one invariant.
    const c = fakeClient();
    scopeClient(c, 'org-a', silent);
    return pool.withOrgScope(c, 'org-a', () => c.query('SELECT 1')).then(() => {
      expect(c.log.filter(([sql]) => sql.includes('set_config'))).toHaveLength(2);
    });
  });

  it('so pool.query borrows through the unpatched connect', () => {
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, '..', 'db', 'pool.js'), 'utf8');
    const patch = src.slice(src.indexOf('pool.query = function slowQueryInstrument'));
    // _origConnect, captured before pool.connect is replaced — not pool.connect.
    expect(patch).toMatch(/_origConnect\(\)\.then\(\(client\)/);
    expect(patch.slice(0, patch.indexOf('};'))).not.toMatch(/pool\.connect\(/);
  });

  it('leaves migrations and the startup probe unpatched', () => {
    // Those borrow outside any request, so currentOrgId() is undefined. The
    // wrapper must return the raw client rather than scoping to "undefined",
    // which would set app.org_id to the string "undefined" and match nothing.
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, '..', 'db', 'pool.js'), 'utf8');
    expect(src).toMatch(/orgId == null \? client : scopeClient\(client, orgId\)/);
  });
});
