'use strict';

/**
 * Migrating on boot is a deploy step, not a development one.
 *
 * server.js used to call runMigrationsWithRetry() unconditionally, so every
 * nodemon restart applied schema changes to whatever database the machine
 * pointed at. That was invisible while DATABASE_URL and MIGRATION_DATABASE_URL
 * were the same local database; once MIGRATION_DATABASE_URL named a remote
 * privileged role, `npm run dev` booted straight into migrate.js's refusal.
 *
 * The boot is exercised in a child process rather than by requiring server.js,
 * because requiring it binds a port, opens pools and starts timers inside the
 * Jest worker. Each spawn runs in a scratch directory so dotenv finds no .env
 * and the result does not depend on this machine's configuration — the same
 * reason migrate.remoteGuard.test.js does it.
 *
 * No database is reached. The production case points at an unresolvable host
 * on purpose: a DNS failure is exactly the proof that it tried to migrate.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const UNREACHABLE = 'postgresql://u:p@db.example.invalid:5432/x';
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:5432/definitely_not_a_real_db?sslmode=disable';

let cwd;
beforeAll(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mga-boot-')); });
afterAll(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

/**
 * Boot the real server and collect output until `settled` matches or the
 * window closes, then kill it. Resolving on a marker rather than waiting out a
 * fixed timeout keeps this fast: the decision is logged within milliseconds,
 * while the server itself would otherwise sit listening forever.
 */
function boot(env, settled, ms = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        // server.js checks REQUIRED_ENV and exits before it reaches the
        // migration decision, so all three have to be present or every case
        // below would "pass" on that exit instead of on the behaviour.
        DATABASE_URL: LOCAL,
        JWT_SECRET: 'startup-migration-test-secret-000000000000',
        FRONTEND_URL: 'http://localhost:3000',
        PORT: '0',              // ask the OS for a free port; never collide with a real one
        RUN_WORKERS: '0',
        COMMAND_CENTER_STREAM: 'off',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const done = () => { clearTimeout(timer); child.kill('SIGKILL'); resolve(out); };
    const timer = setTimeout(done, ms);
    const onData = (b) => { out += b.toString(); if (settled.test(out)) done(); };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => done());
  });
}

const RUNNING = /Running database migrations/;
const SKIPPING = /skipping startup migrations/;

describe('startup migrations are a deploy step', () => {
  it('does not migrate when NODE_ENV is development', async () => {
    const out = await boot(
      { NODE_ENV: 'development', MIGRATION_DATABASE_URL: UNREACHABLE },
      SKIPPING,
    );
    expect(out).toMatch(SKIPPING);
    expect(out).not.toMatch(RUNNING);
    // The refusal this change exists to avoid.
    expect(out).not.toMatch(/refusing to migrate a remote database/);
    expect(out).not.toMatch(/Startup migration failed/);
  }, 40_000);

  it('does not migrate when NODE_ENV is unset, which is what `npm run dev` does', async () => {
    // The dev script is plain `nodemon src/server.js` and sets no NODE_ENV, so
    // a gate written against the literal string 'development' would leave the
    // real-world case broken. This is the case that actually reported the bug.
    const out = await boot({ MIGRATION_DATABASE_URL: UNREACHABLE }, SKIPPING);
    expect(out).toMatch(SKIPPING);
    expect(out).toMatch(/"nodeEnv":"unset"/);
    expect(out).not.toMatch(RUNNING);
  }, 40_000);

  it('still migrates when NODE_ENV is production', async () => {
    const out = await boot(
      {
        NODE_ENV: 'production',
        MIGRATION_DATABASE_URL: UNREACHABLE,
        // Production refuses to boot without object storage configured, and
        // that check runs before the migration decision. These are inert
        // placeholders: nothing here uploads anything.
        R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
        // platformPool.js throws at require time in production when this is
        // absent, deliberately — a platform route that silently returned no
        // rows would be worse. Unreachable here, like the migration URL: this
        // test is about which code path runs, not about reaching a database.
        PLATFORM_DATABASE_URL: UNREACHABLE,
      },
      /Startup migration failed|ENOTFOUND|EAI_AGAIN/,
    );
    expect(out).toMatch(RUNNING);
    expect(out).not.toMatch(SKIPPING);
    // Reaching DNS proves it genuinely attempted the migration rather than
    // logging the line and moving on.
    expect(out).toMatch(/ENOTFOUND|EAI_AGAIN|Startup migration failed/);
  }, 60_000);

  it('gates on production, not on the absence of "development"', () => {
    // The distinction is invisible at runtime for the two cases above but is
    // the whole reason the unset case works, so it is pinned here: a later
    // edit to `NODE_ENV !== 'development'` would pass both tests above and
    // silently restore the bug for anyone whose NODE_ENV is 'test' or unset.
    const src = fs.readFileSync(SERVER, 'utf8');
    expect(src).toMatch(/RUN_STARTUP_MIGRATIONS\s*=\s*process\.env\.NODE_ENV === 'production'/);
    expect(src).not.toMatch(/NODE_ENV !== 'development'/);
  });
});
