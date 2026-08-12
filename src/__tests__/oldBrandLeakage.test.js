'use strict';
// The original product's identity must not be reachable by a user of a fork.
//
// Phase 4/4B removed the hardcoded domains, support addresses, phone number
// and brand strings from runtime source and put them behind configuration.
// This test is the ratchet that keeps them out. It exists because the failure
// mode is silent and off-platform: a studio's own members received a WhatsApp
// message naming a company they had never dealt with and telling them to ring
// its phone number, and nothing in the system could have noticed.
//
// ── What it does and does not scan ────────────────────────────────────────
//
// Runtime source only. Documentation, migration files and this repository's
// own audit write-ups legitimately name the original product — a migration
// called 096_rebrand_gym_name.sql cannot be written without saying what was
// renamed, and scrubbing history to satisfy a linter would destroy the record
// of why the schema looks the way it does.
//
// Comments in runtime files are also allowed, and deliberately so. Several
// explain real decisions in terms of the old deployment's topology (why the
// session cookie was not widened to a parent domain; which WebAuthn origins a
// proxied request presents). Those comments cannot reach a user. Deleting
// them to satisfy a string search would trade a real explanation for a
// cosmetic pass.
//
// So the rule is: a forbidden value may appear in prose, never in an
// expression a user could receive.

const fs = require('fs');
const path = require('path');

const BACKEND_SRC = path.join(__dirname, '..');
const FRONTEND_SRC = path.resolve(__dirname, '..', '..', '..', 'mga-frontend', 'src');

/**
 * Values that identify the original business. Not the brand *name* — that is
 * tracked separately below, because it is still the configured default and a
 * flat ban would be a lie about the current state. These are the ones that
 * route a real person to the original company.
 */
const FORBIDDEN = [
  { pattern: /8756562188/, label: 'old business phone number' },
  { pattern: /619fitnessstudio\.com/i, label: 'old marketing domain' },
  { pattern: /619fitness\.com/i, label: 'old support domain' },
  { pattern: /myptstudio\.com/i, label: 'old product domain' },
];

const SCAN_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx']);

/** Directories that are not runtime code. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'migrations', '.next', 'dist', 'build']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // frontend may not be checked out beside the backend
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (SCAN_EXTENSIONS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * Strip comments so prose describing the old deployment does not register as
 * a value a user could receive. Block comments first, then line comments.
 *
 * `//` inside a string literal (`'https://example.com'`) would be truncated by
 * a naive line-comment strip, which is fine here: truncating makes the scan
 * see LESS, and the only risk that matters is seeing less of a forbidden
 * value than exists. A URL containing a forbidden host still has that host
 * before the `//`… except it does not — `https://myptstudio.com` puts the
 * host after. So line comments are only stripped when the `//` starts the
 * line, which is where explanatory prose lives and where a URL never does.
 */
function stripProse(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

function scan(roots) {
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const code = stripProse(fs.readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        for (const { pattern, label } of FORBIDDEN) {
          if (pattern.test(line)) {
            hits.push(`${path.relative(path.join(__dirname, '..', '..', '..'), file)}:${i + 1}  [${label}]`);
          }
        }
      });
    }
  }
  return hits;
}

describe('the original product is not reachable from runtime code', () => {
  test('no forbidden identifier appears in backend or frontend runtime source', () => {
    expect(scan([BACKEND_SRC, FRONTEND_SRC])).toEqual([]);
  });

  test('the scan actually reaches the frontend, not just the backend', () => {
    // Without this, a wrong FRONTEND_SRC path would make the assertion above
    // pass by scanning nothing — the same silent-widening failure that broke
    // tenantRlsFlag.test.js. A file count is enough; the frontend is large.
    expect(walk(FRONTEND_SRC).length).toBeGreaterThan(50);
  });

  test('the patterns match the formats these values actually appear in', () => {
    // The guard rests on these regexes. A phone number written with spaces,
    // hyphens or a country code is the same number to the person dialling it.
    const digits = (s) => s.replace(/[^\d]/g, '');
    for (const written of ['8756562188', '+918756562188', '+91-8756562188', '91 8756562188']) {
      expect(FORBIDDEN[0].pattern.test(digits(written))).toBe(true);
    }
    expect(FORBIDDEN[1].pattern.test('https://619fitnessstudio.com/sitemap.xml')).toBe(true);
    expect(FORBIDDEN[2].pattern.test('mailto:support@619fitness.com')).toBe(true);
    expect(FORBIDDEN[3].pattern.test('https://app.myptstudio.com')).toBe(true);
    // And do not fire on unrelated text.
    expect(FORBIDDEN[3].pattern.test('https://app.example.com')).toBe(false);
  });

  test('prose is exempt but expressions are not', () => {
    expect(stripProse("// see myptstudio.com for context")).not.toMatch(/myptstudio/);
    expect(stripProse(" * historically myptstudio.com")).not.toMatch(/myptstudio/);
    expect(stripProse("const u = 'https://myptstudio.com';")).toMatch(/myptstudio/);
  });
});
