// The security overrides must stay above the vulnerable ranges.
//
// Audit finding H-01. Two advisories — a CVSS 9.8 arbitrary-code-execution in
// protobufjs and four libvips CVEs in sharp — both arrive through
// @xenova/transformers, which the knowledge base needs for local embeddings.
//
// npm's own suggested remedy was to DOWNGRADE @xenova/transformers to 1.4.2,
// a semver-major step backwards that would have taken the embedding pipeline
// with it. The fix is instead an `overrides` block forcing patched versions of
// the two transitive packages.
//
// Overrides are quiet when they break. A dependency bump, a lockfile
// regeneration, or someone tidying package.json can drop one and nothing
// fails — the install succeeds, the app boots, and the vulnerable version is
// simply back. This test is what notices.

const pkg = require('../../package.json');

/**
 * Lowest version that clears each advisory, from `npm audit` at the time of
 * the fix. Deliberately the ADVISORY floor rather than the version we happen
 * to have installed: bumping the override higher should not require touching
 * this file, but dropping below the floor must fail.
 */
const FLOORS = {
  // protobufjs: "Arbitrary code execution", CVSS 9.8, vulnerable <7.5.5.
  // Later advisories in the same package reach <=7.6.2, so the override sits
  // on 8.x, which clears all of them.
  protobufjs: 8,
  // sharp: inherited libvips CVEs (2026-33327 / 33328 / 35590 / 35591),
  // vulnerable <0.35.0.
  sharp: 0,
};

/** Major.minor of a range like "^8.7.1" or ">=0.35.3". */
function parse(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(range || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

describe('security overrides (audit H-01)', () => {
  it('declares an overrides block at all', () => {
    expect(pkg.overrides).toBeTruthy();
  });

  it('pins protobufjs above the arbitrary-code-execution advisory', () => {
    // Vulnerable <=7.6.2. Anything on 8.x or later clears every open advisory.
    const v = parse(pkg.overrides?.protobufjs);
    expect(v).not.toBeNull();
    expect(v.major).toBeGreaterThanOrEqual(FLOORS.protobufjs);
  });

  it('pins sharp above the libvips advisories', () => {
    // Vulnerable <0.35.0.
    const v = parse(pkg.overrides?.sharp);
    expect(v).not.toBeNull();
    const ok = v.major > 0 || (v.major === 0 && v.minor >= 35);
    expect(ok).toBe(true);
  });

  it('keeps @xenova/transformers on 2.x rather than the downgrade npm suggests', () => {
    // `npm audit fix` wants 1.4.2. That is a major step BACKWARDS and would
    // break lib/ai/embeddings.js, which is the only reason the package is
    // here. If this ever reads 1.x, someone ran audit fix and shipped it.
    const declared = pkg.dependencies?.['@xenova/transformers'];
    expect(declared).toBeTruthy();
    const v = parse(declared);
    expect(v.major).toBeGreaterThanOrEqual(2);
  });
});
