'use strict';
// Every borrowed client must open a transaction, or the tenant wrapper cannot
// scope it.
//
// db/pool.js hooks BEGIN. That is the whole mechanism: a client borrowed with
// pool.connect() gets app.org_id set immediately after its own BEGIN, inside
// that transaction, on that connection. A borrow that never begins a
// transaction therefore carries no org id at all — and once DATABASE_URL points
// at app_tenant, every statement it runs matches no policy and sees zero rows.
// Silently, because RLS filters rather than errors.
//
// There was exactly one such path: members.service.js's member-code generator,
// which held a SESSION-level advisory lock outside any transaction. That module
// has since been deleted along with the /api/v1/members endpoint it served (see
// MEMBERS-TENANT-GAP.md), so the specific assertions about it are gone — but the
// rule it existed to enforce is the point, and that stays. This test is what
// stops the next such path appearing.
//
// Deliberately source-level. The alternative — asserting against a live
// database — would only cover the paths a test happens to exercise, and the
// ones that matter here are the rarely-hit write paths.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');

function sources(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') sources(p, out); continue; }
    if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (f) => path.relative(path.join(SRC, '..'), f).replace(/\\/g, '/');

/**
 * Borrows that legitimately run outside a request, where currentOrgId() is
 * undefined and the wrapper is a no-op by design. Each needs a reason, not
 * just an entry.
 */
const OUTSIDE_A_REQUEST = {
  'src/db/migrate.js': 'migrations run at deploy time, before any request exists',
  'src/db/pool.js': 'the startup connectivity probe, and the wrapper\'s own plumbing',
};

/** Collect every pool.connect() borrow and whether its body opens a transaction. */
function borrows() {
  const found = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/pool\.connect\(\)/.test(line)) return;
      // Comments describing the pattern are not borrows.
      if (/^\s*(\/\/|\*)/.test(line)) return;

      // Walk to the matching release(), which every borrow in this repo has.
      let begins = false;
      for (let j = i; j < Math.min(lines.length, i + 400); j++) {
        if (/\.query\(\s*['"`]\s*(BEGIN|START TRANSACTION)/i.test(lines[j])) begins = true;
        if (/\.release\(\)/.test(lines[j])) break;
      }
      found.push({ file: rel(file), line: i + 1, begins });
    });
  }
  return found;
}

describe('borrowed clients and the tenant wrapper', () => {
  const all = borrows();

  it('found the borrows it is supposed to be checking', () => {
    // If this collapses to a handful, the walk broke and everything below
    // passes for nothing.
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  it('every request-path borrow opens a transaction', () => {
    const gaps = all
      .filter((b) => !b.begins)
      .filter((b) => !OUTSIDE_A_REQUEST[b.file])
      .map((b) => `${b.file}:${b.line}`);
    // A non-empty list here means those call sites borrow a client and never
    // BEGIN, so db/pool.js cannot set app.org_id on them — they will return
    // zero rows once DATABASE_URL points at app_tenant. Jest prints the array,
    // which names the file and line.
    expect(gaps).toEqual([]);
  });

  it('the exempt files are exempt for a stated reason, and only those', () => {
    // Stops the allowlist becoming a place to hide a real gap.
    const exempt = all.filter((b) => !b.begins && OUTSIDE_A_REQUEST[b.file]);
    for (const b of exempt) {
      expect(OUTSIDE_A_REQUEST[b.file]).toBeTruthy();
    }
    expect(Object.keys(OUTSIDE_A_REQUEST).sort()).toEqual(['src/db/migrate.js', 'src/db/pool.js']);
  });
});
