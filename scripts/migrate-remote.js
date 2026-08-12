#!/usr/bin/env node
'use strict';
/**
 * Migrate a database that is not on this machine — deliberately.
 *
 * `npm run migrate` refuses a remote target outside production, because
 * server.js migrates on boot and .env is where a production URL naturally
 * lands: the two together turned `npm run dev` into a production migration.
 * This is the way through, and it is a separate command so that reaching for
 * it is a decision rather than a default.
 *
 *   MIGRATION_DATABASE_URL=... npm run migrate:remote
 *
 * It requires the URL to be supplied to THIS command rather than read from
 * .env, prints the host and the pending migrations, and waits for the host
 * name to be typed back before touching anything.
 */

const path = require('path');
const readline = require('readline');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Captured before anything can load dotenv, so "supplied explicitly" means
// exactly that. A URL sitting in .env will not satisfy this.
const URL_FROM_COMMAND = process.env.MIGRATION_DATABASE_URL || '';

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!URL_FROM_COMMAND) {
  die(
    'MIGRATION_DATABASE_URL must be supplied to this command.\n'
    + '    A value in .env is deliberately not accepted — that is the mistake\n'
    + '    this command exists to prevent.\n\n'
    + '    MIGRATION_DATABASE_URL="postgresql://…" npm run migrate:remote',
  );
}

let host;
try { host = new URL(URL_FROM_COMMAND).hostname; }
catch { die('MIGRATION_DATABASE_URL is not a valid URL'); }

// Never the URL itself: it carries the password.
console.log('');
console.log('  About to run migrations against a REMOTE database.');
console.log(`    host : ${host}`);
console.log(`    node : ${process.env.NODE_ENV || 'unset'}`);

const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
console.log(`    migrations on disk : ${files.length} (newest ${files[files.length - 1]})`);
console.log('');
console.log('  Pending ones will be applied in order. Already-applied files are skipped.');
console.log(`  Type the host name to continue, anything else to abort:`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('  > ', (answer) => {
  rl.close();
  if (answer.trim() !== host) {
    console.error('✗ aborted — that did not match the host name.');
    process.exit(1);
  }
  console.log('');
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
      // MIGRATION_ALLOW_REMOTE is set here and nowhere else: migrate.js reads
      // it from the real environment before dotenv runs, so this is the only
      // thing that can grant the exception, and only for this child process.
      env: { ...process.env, MIGRATION_ALLOW_REMOTE: '1' },
      stdio: 'inherit',
    });
  } catch {
    // migrate.js has already printed the failure; adding a stack helps nobody.
    process.exit(1);
  }
});
