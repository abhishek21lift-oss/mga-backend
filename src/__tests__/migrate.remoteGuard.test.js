'use strict';

/**
 * `npm run dev` must not migrate a database on another machine.
 *
 * server.js calls runMigrationsWithRetry() on every boot, and .env is where a
 * production MIGRATION_DATABASE_URL naturally ends up — pool.js loads dotenv
 * on import, so by the time migrate.js reads the variable it is already there.
 * Nothing about that is obviously wrong from any single file, which is why it
 * held long enough to apply migration 162 to Supabase from a laptop.
 *
 * These tests run the real command in a child process rather than reading the
 * source, because the thing worth protecting is the behaviour of `node
 * src/db/migrate.js`, not the presence of a function. Each spawn passes its
 * own environment, so the result does not depend on whatever this machine
 * happens to have in .env.
 *
 * No database is reached: a refusal happens before any connection, and the
 * "allowed" cases point at an unresolvable host on purpose, so a DNS failure
 * is the proof they got through the guard.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIGRATE = path.join(__dirname, '..', 'db', 'migrate.js');
const REMOTE = 'postgresql://u:p@db.example.invalid:5432/x';
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:5432/definitely_not_a_real_db?sslmode=disable';

// dotenv resolves `.env` against process.cwd(), so a child started in the repo
// picks up whatever this developer happens to have there — including, on the
// machine where this was written, a production URL. Every spawn below runs in
// a scratch directory instead, so these assertions describe the guard rather
// than the state of somebody's working copy. migrate.js finds its own
// migrations via __dirname, so moving cwd changes nothing else.
let cwd;
beforeAll(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mga-migrate-guard-')); });
afterAll(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

/** Run migrate.js with a controlled environment and a controlled .env. */
function runMigrate(env, dotenvContents) {
  const envFile = path.join(cwd, '.env');
  if (dotenvContents === undefined) fs.rmSync(envFile, { force: true });
  else fs.writeFileSync(envFile, dotenvContents);

  const r = spawnSync(process.execPath, [MIGRATE], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,   // Windows: DNS resolution needs it
      // pool.js exits on a missing DATABASE_URL before migrate.js runs at all,
      // so without a default every case below would "pass" on that error
      // instead of on the guard. Overridden by `env` where a test needs to.
      DATABASE_URL: LOCAL,
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

const REFUSAL = /refusing to migrate a remote database/;

describe('migrations refuse an unintended remote target', () => {
  it('refuses a remote database when NODE_ENV is not production', () => {
    const out = runMigrate({ MIGRATION_DATABASE_URL: REMOTE });
    expect(out).toMatch(REFUSAL);
    // Names the host so the mistake is obvious…
    expect(out).toMatch(/db\.example\.invalid/);
    // …and never the URL, which carries the password.
    expect(out).not.toMatch(/u:p@/);
  });

  it('refuses even when only DATABASE_URL is remote', () => {
    // The hazard is not specific to MIGRATION_DATABASE_URL: with it unset,
    // migrations fall back to DATABASE_URL and would migrate that instead.
    const out = runMigrate({ DATABASE_URL: REMOTE });
    expect(out).toMatch(REFUSAL);
    expect(out).toMatch(/via DATABASE_URL/);
  });

  it('cannot be switched off by putting the flag in .env', () => {
    // The documented promise, tested for real: a .env granting the exception
    // is written to disk where dotenv will certainly load it, and it still
    // refuses — because migrate.js captures the flag above `require('./pool')`,
    // which is the line that loads dotenv.
    const out = runMigrate({}, `MIGRATION_ALLOW_REMOTE=1\nMIGRATION_DATABASE_URL=${REMOTE}\n`);
    expect(out).toMatch(REFUSAL);
    expect(out).toMatch(/db\.example\.invalid/);
  });

  it('reads the URL from .env — so the refusal is about intent, not availability', () => {
    // Establishes that .env IS otherwise honoured here. Without this, the test
    // above could pass simply because the child never saw the file at all.
    const out = runMigrate({}, `MIGRATION_DATABASE_URL=${REMOTE}\n`);
    expect(out).toMatch(REFUSAL);
    expect(out).toMatch(/db\.example\.invalid/);
    expect(out).toMatch(/via MIGRATION_DATABASE_URL/);
  });

  it('does not refuse a local target', () => {
    const out = runMigrate({ MIGRATION_DATABASE_URL: LOCAL });
    expect(out).not.toMatch(REFUSAL);
    // It fails for an ordinary reason — the database does not exist — which is
    // what proves the guard let it through rather than that nothing ran.
    expect(out).toMatch(/does not exist|ECONNREFUSED|Migration failed/);
  });

  it('allows a remote target when the flag is supplied on the command line', () => {
    const out = runMigrate({ MIGRATION_DATABASE_URL: REMOTE, MIGRATION_ALLOW_REMOTE: '1' });
    expect(out).not.toMatch(REFUSAL);
    expect(out).toMatch(/ENOTFOUND|EAI_AGAIN|Migration failed/);
  });

  it('allows a remote target in production, so deploys are unchanged', () => {
    const out = runMigrate({ MIGRATION_DATABASE_URL: REMOTE, NODE_ENV: 'production' });
    expect(out).not.toMatch(REFUSAL);
    expect(out).toMatch(/ENOTFOUND|EAI_AGAIN|Migration failed/);
  });

  it('reads its escape hatch before dotenv can supply one', () => {
    // The ordering is the mechanism, and it is invisible at the call site: the
    // capture must stay ABOVE `require('./pool')`, which loads dotenv. If a
    // later edit moves it down, .env regains the ability to grant the
    // exception and every test above still passes.
    const src = require('node:fs').readFileSync(MIGRATE, 'utf8');
    const flagAt = src.indexOf('MIGRATION_ALLOW_REMOTE');
    const poolAt = src.indexOf("require('./pool')");
    expect(flagAt).toBeGreaterThan(-1);
    expect(poolAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(poolAt);
  });
});
