'use strict';
// Every storage category must have a tenant-ownership rule.
//
// routes/uploads.js resolves whether the caller may read an object by looking
// its category up in an allowlist. The last line of that resolution is:
//
//     if (!table) return true; // not an owned category — a valid session suffices
//
// which is fail-OPEN. For a category nobody registered, any authenticated user
// of any studio who holds the key gets the object. That is the correct
// behaviour for genuinely public assets — an avatar, a studio logo — and
// exactly wrong for anything else.
//
// Today the allowlist is complete: parq, informed-consent and knowledge are
// registered, portfolio, upi-proof and progress-reports have their own
// resolvers, and profile is deliberately public. Nothing leaks. But that is a
// property of the current code, not of the design, and the failure mode of
// adding a seventh category is silent: uploads keep working, downloads keep
// working, and the objects are readable across the tenant boundary by anyone
// with a key.
//
// PostgreSQL RLS cannot catch this. The objects live in Cloudflare R2, which
// has never heard of app.org_id — the database row is protected, the bytes are
// not. This file is the only thing standing between a new upload path and a
// cross-tenant read, so it derives the category list from the source rather
// than restating it.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const UPLOADS = fs.readFileSync(path.join(SRC, 'routes', 'uploads.js'), 'utf8');

/** Categories deliberately served without an ownership check. */
const PUBLIC_CATEGORIES = new Set([
  'profile',    // avatars — rendered in <img> by anyone who can see the person
  'org-logos',  // studio branding, shown on public sign-in and invitation pages
]);

/** Scan the codebase for object-key prefixes that get written to storage. */
function writtenCategories() {
  const files = [];
  for (const dir of ['lib', 'routes', 'modules']) {
    (function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    })(path.join(SRC, dir));
  }

  // Anchored on the storage API rather than on string shape. saveFile() is
  // the only way an object reaches R2 or the local disk, and its first
  // argument is the category — so this asks "what gets written" instead of
  // "what looks like a path". An earlier version matched any `word/` literal
  // and picked up AI model ids (openai/…, nvidia/…) and npm scopes, which
  // would have meant maintaining a denylist forever.
  const found = new Set();
  const re = /saveFile\(\s*[`'"]([a-z][a-z0-9-]*)(?:\/[a-z0-9-]+)?[`'"]/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src))) found.add(m[1]);
  }
  return found;
}

describe('every storage category has a tenant-ownership rule', () => {
  test('uploads.js still fails open for unregistered categories', () => {
    // If this ever stops being true the rest of this file is obsolete rather
    // than wrong — but it should be noticed deliberately, not discovered.
    expect(UPLOADS).toMatch(/if \(!table\) return true;/);
  });

  test('every category written to storage is registered, special-cased, or explicitly public', () => {
    const written = writtenCategories();
    // Sanity: the scan has to actually find something, or this test passes by
    // looking at nothing — the failure mode that makes a guard worthless.
    expect(written.size).toBeGreaterThan(2);

    const unregistered = [];
    for (const category of written) {
      const inAllowlist = new RegExp(`['"]${category}['"]\\s*:`).test(UPLOADS);
      const specialCased = new RegExp(`=\\s*['"]${category}['"]`).test(UPLOADS);
      const isPublic = PUBLIC_CATEGORIES.has(category);
      if (!inAllowlist && !specialCased && !isPublic) unregistered.push(category);
    }

    // A category here means: something writes objects under this prefix, and
    // routes/uploads.js will serve them to any authenticated user in any
    // studio. Register it in OWNED_CATEGORIES with its owning table, give it a
    // resolver, or add it to PUBLIC_CATEGORIES above with a reason.
    expect(unregistered).toEqual([]);
  });

  test('public categories are a short, deliberate list', () => {
    // Guards the escape hatch itself: PUBLIC_CATEGORIES is how a category
    // opts out of the ownership check, so it should stay small enough that
    // every entry can be justified in review.
    expect(PUBLIC_CATEGORIES.size).toBeLessThanOrEqual(4);
  });
});
