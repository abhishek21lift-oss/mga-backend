// Contract test for otplib — the ONE test here that does not mock it.
//
// ── Why this file exists ────────────────────────────────────────────────────
// otplib v13 removed the `authenticator` singleton that v12 exported. Every
// call site in this app used it, so after the bump `authenticator` was
// `undefined` and `authenticator.check(...)` threw — meaning no super admin
// with 2FA enabled could log in. Nothing caught it: mfa.verify.test.js mocked
// otplib with the v12 shape, so the mock happily asserted an API that no
// longer existed, and auth.login.test.js could not even parse.
//
// A mock can only ever prove the code matches the mock. This file proves the
// code matches the LIBRARY.
//
// ── Why it shells out to Node ───────────────────────────────────────────────
// otplib's CJS build requires @scure/base, which is ESM-only. Node resolves
// that fine; Jest's own module resolver does not and throws "Unexpected token
// 'export'". Running the check in a real `node -e` subprocess tests the exact
// path production takes — including that the require itself works — instead of
// testing whatever Jest's resolver happens to do.
'use strict';

const { execFileSync } = require('child_process');

/** Run a snippet in a real Node process and return its parsed JSON stdout. */
function inNode(script) {
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: 20000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('otplib contract', () => {
  test('the module can be required at all', () => {
    // If this fails the server does not boot: routes/auth.js requires otplib
    // at module scope.
    const r = inNode(`
      const o = require('otplib');
      console.log(JSON.stringify({ ok: true, keys: Object.keys(o) }));
    `);
    expect(r.ok).toBe(true);
  });

  test('exports the functions this app actually calls', () => {
    const r = inNode(`
      const o = require('otplib');
      console.log(JSON.stringify({
        generateSecret: typeof o.generateSecret,
        verifySync: typeof o.verifySync,
      }));
    `);
    expect(r.generateSecret).toBe('function');
    expect(r.verifySync).toBe('function');
  });

  test('generateSecret returns a base32 string a TOTP app can accept', () => {
    const r = inNode(`
      const { generateSecret } = require('otplib');
      const s = generateSecret();
      console.log(JSON.stringify({ type: typeof s, value: s }));
    `);
    expect(r.type).toBe('string');
    expect(r.value).toMatch(/^[A-Z2-7]{16,}$/);
  });

  test('a freshly generated code verifies, and a wrong one does not', () => {
    const r = inNode(`
      const { generateSecret, generateSync, verifySync } = require('otplib');
      const secret = generateSecret();
      const token = generateSync({ secret, strategy: 'totp' });
      console.log(JSON.stringify({
        good: verifySync({ secret, token, strategy: 'totp', epochTolerance: 30 }),
        bad:  verifySync({ secret, token: '000000', strategy: 'totp', epochTolerance: 30 }),
      }));
    `);
    expect(r.good.valid).toBe(true);
    expect(r.bad.valid).toBe(false);
  });

  test('verifySync returns an OBJECT, not a boolean', () => {
    // This is the precise shape of the bug that shipped. A failed
    // verification returns `{ valid: false }`, and `{ valid: false }` is
    // TRUTHY — so `if (verifySync(...))` would accept every code, including
    // wrong ones. Call sites must read `.valid`.
    const r = inNode(`
      const { generateSecret, verifySync } = require('otplib');
      const bad = verifySync({
        secret: generateSecret(), token: '000000', strategy: 'totp', epochTolerance: 30,
      });
      console.log(JSON.stringify({ type: typeof bad, truthy: Boolean(bad), valid: bad.valid }));
    `);
    expect(r.type).toBe('object');
    expect(r.truthy).toBe(true);   // the trap
    expect(r.valid).toBe(false);   // the correct reading
  });
});
