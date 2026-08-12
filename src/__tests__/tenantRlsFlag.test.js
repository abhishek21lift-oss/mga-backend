'use strict';
// TENANT_RLS_ENFORCE gates two independent files — middleware/auth.js
// (resolves the org id, opens the AsyncLocalStorage context) and db/pool.js
// (reads it, decides whether to wrap a query in a transaction). If the two
// ever read different env vars, or default to different values, one half
// of the plumbing could be "on" while the other stays "off" — the org
// context gets set but nothing reads it, or a query gets wrapped with no
// context to set, neither of which TENANT-RLS-PLAN.md's staged rollout can
// tell apart from "working". Reading the source rather than exercising a
// live request, same reasoning as this repo's other tenant convention
// tests: no live database in CI, and a source check catches the drift on
// the branch instead of on a staging run.
//
// ── On reading source as text ──────────────────────────────────────────
// An earlier version of this file located the enforcement branch by slicing
// between two hardcoded string markers, one of which embedded both a literal
// "\n" and an exact indentation depth. That made a security invariant depend
// on two things it has nothing to do with. It broke twice over on Windows:
// the checkout rewrote the file to CRLF so the "\n" never matched, indexOf
// returned -1, and `slice(start, -1)` silently widened to the whole rest of
// the file — which of course contains a res.status, so the test reported a
// violation that was not there. Red locally, green in Linux CI, pointing at
// the wrong thing.
//
// The repository now carries a .gitattributes that normalises to LF, but a
// test asserting an invariant should not be re-breakable by reformatting the
// file it inspects. So: normalise line endings on read, find the branch by
// matching braces rather than by guessing its indentation, and strip comments
// before looking for calls, since prose describing res.status is not a call
// to it. The four assertions below are unchanged in what they require.

const fs = require('fs');
const path = require('path');

/** Read source with line endings normalised, so a CRLF checkout cannot
 *  change what these assertions see. */
function readSource(...segments) {
  return fs
    .readFileSync(path.join(__dirname, '..', ...segments), 'utf8')
    .replace(/\r\n/g, '\n');
}

/** Remove line and block comments, so a comment mentioning a call is not
 *  mistaken for the call itself. Deliberately simple — it does not track
 *  strings or regex literals, which the blocks inspected here do not use. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The body of the first block opening with `header`, found by matching
 *  braces from the header's own `{`. Independent of indentation, line
 *  endings, and anything after the block closes. Throws rather than
 *  returning something misleading if the header is absent — the silent
 *  widening that behaviour replaces is what broke this file before. */
function blockAfter(src, header) {
  const at = src.indexOf(header);
  if (at === -1) throw new Error(`header not found in source: ${header}`);
  let i = src.indexOf('{', at);
  if (i === -1) throw new Error(`no block opens after header: ${header}`);
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after header: ${header}`);
}

const auth = readSource('middleware', 'auth.js');
const poolSrc = readSource('db', 'pool.js');

describe('TENANT_RLS_ENFORCE — the two halves of the flag agree', () => {
  it('both files gate on the exact same env var, read the exact same way', () => {
    const FLAG = "process.env.TENANT_RLS_ENFORCE === 'on'";
    expect(auth).toContain(FLAG);
    expect(poolSrc).toContain(FLAG);
  });

  it('defaults off — unset or any value other than the literal string "on" stays off', () => {
    // === 'on' rather than a truthy check: an operator setting
    // TENANT_RLS_ENFORCE=true or =1 by habit from other flags in this repo
    // must not silently turn on a transaction wrapper nobody meant to flip.
    expect(auth).not.toMatch(/TENANT_RLS_ENFORCE\s*\?\?/);
    expect(auth).not.toMatch(/Boolean\(process\.env\.TENANT_RLS_ENFORCE\)/);
  });

  it("auth.js never blocks a request when org-id resolution fails — it only feeds a query wrapper, it is not a new authorization gate", () => {
    const branch = blockAfter(auth, 'if (TENANT_RLS_ENFORCE) {');
    expect(branch).toMatch(/try\s*\{\s*orgId\s*=\s*resolveOrgId\(req\);\s*\}\s*catch/);
    // No res.status(...) inside the enforcement branch — a failure to
    // resolve an org id here must fall through to orgId = null, not reject
    // the request. NO_TENANT rejection is requireRole/requireClient's job
    // further down the chain, not this flag's.
    expect(stripComments(branch)).not.toMatch(/res\.status/);
  });

  it("pool.js's wrapper is a straight pass-through when there is no org id, on or off", () => {
    const patch = poolSrc.slice(poolSrc.indexOf('pool.query = function slowQueryInstrument'));
    expect(patch).not.toHaveLength(0);
    // Whitespace-insensitive: the requirement is that a null org id calls the
    // original query directly rather than borrowing a client for a
    // transaction, not that the ternary is formatted across any given number
    // of lines.
    expect(patch).toMatch(/orgId\s*==\s*null\s*\?\s*_origQuery\(\.\.\.args\)/);
  });
});
