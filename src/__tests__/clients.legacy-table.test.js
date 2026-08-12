// Nothing mounted at /api/clients may touch the legacy `clients` table.
//
// ── Why this table is different from every other one ────────────────────────
//
// `clients` has no organization_id column. Not "is missing a filter" — there is
// nothing to filter ON. Any handler reading or writing it is unscopable by
// construction, and this mount sits behind plain `auth`, so such a handler is
// reachable by any logged-in user of any studio.
//
// That is exactly what used to be here. routes/client-actions.js carried
// thirteen endpoints — freeze, unfreeze, transfer, upgrade, downgrade, combo,
// trial, assign-pt, extension, renew-pt, add-subscription, renew-subscription,
// photo — every one of them `SELECT * FROM clients WHERE id=$1` followed by an
// `UPDATE clients`. routes/clients.js carried two more (renew, pt-renew).
//
// None of it ever did damage, and the reason is worth stating plainly because
// it is not a good one: the table has held 0 rows since the PT-OS enrolment
// flow shipped, so every handler 404'd before reaching its UPDATE. The safety
// came from the data, not from the code. One inserted row would have turned
// fifteen endpoints into a cross-tenant write surface.
//
// ── Why a source scan and not a request test ────────────────────────────────
//
// The bug is not "returns the wrong answer" — it is "this query exists at all".
// A request test would need a database with rows in a table that is supposed to
// stay empty, and it would pass for the wrong reason (404) right up until the
// day it stopped passing for the wrong reason.
//
// The mount list is read out of server.js rather than hardcoded, so a second
// router added to /api/clients is covered the day it is added.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const SERVER = path.join(SRC, 'server.js');

/**
 * `clients` as a table name, never `pt_clients`.
 *
 * The negative lookbehind on `_` is what keeps this from matching pt_clients,
 * which every legitimate handler on this mount uses. Aliases (`clients c`) and
 * schema-qualified forms both still match on the table name itself.
 */
const LEGACY_SQL = /\b(?:FROM|UPDATE|INTO|JOIN)\s+(?<!_)clients\b/i;

/** Which files does server.js mount at /api/clients? */
function mountedAtApiClients() {
  const server = fs.readFileSync(SERVER, 'utf8');
  const files = [];
  // app.use('/api/clients', ..., require('./routes/whatever'))
  const re = /app\.use\(\s*'\/api\/clients'[^\n]*require\('(\.[^']+)'\)/g;
  let m;
  while ((m = re.exec(server)) !== null) files.push(m[1]);
  return files;
}

function resolveRoute(rel) {
  const base = path.join(SRC, rel);
  return fs.existsSync(base) ? base : `${base}.js`;
}

describe('/api/clients and the un-scopable legacy table', () => {
  test('at least one router is mounted there — the scan has something to scan', () => {
    // Without this, deleting the mount entirely would make every assertion
    // below pass against nothing at all.
    expect(mountedAtApiClients().length).toBeGreaterThan(0);
  });

  test('no file mounted at /api/clients reads or writes the legacy `clients` table', () => {
    const offenders = [];
    for (const rel of mountedAtApiClients()) {
      const file = resolveRoute(rel);
      // Split on \r?\n, not \n. On a CRLF checkout a plain \n split leaves a
      // trailing \r on every line, and `\r` is a line terminator that `.` does
      // not match and `$` will not cross — so the comment stripper below
      // silently stopped stripping, and the explanatory comment at
      // routes/clients.js:279, which quotes the very SQL this test forbids,
      // was reported as an offender. The repo now normalises to LF via
      // .gitattributes; this keeps the scan correct regardless.
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Comments are the record of WHY these were removed; they quote the
        // very SQL this test forbids, and must not trip it.
        const code = line.replace(/^\s*(\/\/|\*).*$/, '');
        if (LEGACY_SQL.test(code)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('routes/client-actions.js is gone, not merely unmounted', () => {
    // Unmounting alone would leave 734 lines that the next person could
    // reasonably re-mount, all of it still un-scopable.
    expect(fs.existsSync(path.join(SRC, 'routes', 'client-actions.js'))).toBe(false);
  });

  test('the pattern distinguishes `clients` from `pt_clients`', () => {
    // The whole guard rests on this one regex. If it matched pt_clients the
    // suite would be unpassable; if it missed `clients` it would be useless.
    expect(LEGACY_SQL.test('SELECT * FROM clients WHERE id=$1')).toBe(true);
    expect(LEGACY_SQL.test('UPDATE clients SET status=$1')).toBe(true);
    expect(LEGACY_SQL.test('INSERT INTO clients (id) VALUES ($1)')).toBe(true);
    expect(LEGACY_SQL.test('JOIN clients c ON c.id = p.client_id')).toBe(true);
    expect(LEGACY_SQL.test('SELECT * FROM pt_clients WHERE id=$1')).toBe(false);
    expect(LEGACY_SQL.test('UPDATE pt_clients SET status=$1')).toBe(false);
    expect(LEGACY_SQL.test('JOIN pt_clients pc ON pc.id = s.client_id')).toBe(false);
  });
});
