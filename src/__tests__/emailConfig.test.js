// The boot-time SMTP check.
//
// Worth testing because the whole point of the check is to catch a state
// nothing else catches — a server that starts clean and silently sends no
// email. A check that itself failed to notice would restore exactly the
// blind spot it exists to remove.
'use strict';

const { describeConfig, REQUIRED_VARS } = require('../lib/email');

const ENV = (o) => ({ ...o });

describe('describeConfig', () => {
  it('names the three variables lib/email.js actually requires', () => {
    // isConfigured() is `SMTP_HOST && SMTP_USER && SMTP_PASS`. If that gains a
    // fourth requirement and this list does not, the boot check goes quiet
    // about the very thing that breaks sending.
    expect(REQUIRED_VARS).toEqual(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
  });

  it('reports configured when all three are set', () => {
    expect(describeConfig(ENV({ SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'a@b.com', SMTP_PASS: 'x' })))
      .toEqual({ state: 'configured', set: REQUIRED_VARS, missing: [] });
  });

  it('reports absent when none are', () => {
    const r = describeConfig(ENV({}));
    expect(r.state).toBe('absent');
    expect(r.missing).toEqual(REQUIRED_VARS);
  });

  it('reports partial for every incomplete combination, and says which are missing', () => {
    // Each of the six ways to get it half-right. Partial is the dangerous
    // state: it looks like somebody configured email.
    const combos = [
      [{ SMTP_HOST: 'h' }, ['SMTP_USER', 'SMTP_PASS']],
      [{ SMTP_USER: 'u' }, ['SMTP_HOST', 'SMTP_PASS']],
      [{ SMTP_PASS: 'p' }, ['SMTP_HOST', 'SMTP_USER']],
      [{ SMTP_HOST: 'h', SMTP_USER: 'u' }, ['SMTP_PASS']],
      [{ SMTP_HOST: 'h', SMTP_PASS: 'p' }, ['SMTP_USER']],
      [{ SMTP_USER: 'u', SMTP_PASS: 'p' }, ['SMTP_HOST']],
    ];
    for (const [env, missing] of combos) {
      const r = describeConfig(ENV(env));
      expect(r.state).toBe('partial');
      expect(r.missing).toEqual(missing);
    }
  });

  it('treats an empty string as unset', () => {
    // An env var declared in a deployment file but left blank arrives as '' rather
    // than undefined. isConfigured() is falsy on it, so this must agree —
    // otherwise the check reports "configured" for a server that cannot send.
    const r = describeConfig(ENV({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: '' }));
    expect(r.state).toBe('partial');
    expect(r.missing).toEqual(['SMTP_PASS']);
  });

  it('ignores SMTP_PORT and SMTP_FROM, which sending does not require', () => {
    // Both have working defaults (587, and a fallback from-address). Listing
    // them would cry wolf on a correctly-configured server.
    expect(describeConfig(ENV({ SMTP_PORT: '465', SMTP_FROM: 'a@b.com' })).state).toBe('absent');
  });

  it('reads the environment when called, not when the module loaded', () => {
    const before = describeConfig(ENV({})).state;
    const after = describeConfig(ENV({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })).state;
    expect([before, after]).toEqual(['absent', 'configured']);
  });

  it('agrees with isConfigured() on every combination', () => {
    // The two must never disagree: one decides whether to send, the other
    // decides whether to warn about not sending.
    //
    // Deliberately not destructured up here: isConfigured() closes over
    // values read at module load, so the binding would be stale for every
    // iteration below. The loop re-requires the module each time instead.
    const saved = { ...process.env };
    try {
      for (const bits of [0, 1, 2, 3, 4, 5, 6, 7]) {
        REQUIRED_VARS.forEach((k, i) => {
          if (bits & (1 << i)) process.env[k] = 'v'; else delete process.env[k];
        });
        // isConfigured() closes over module-load values, so reload it.
        jest.resetModules();
        const fresh = require('../lib/email');
        expect(fresh.describeConfig().state === 'configured').toBe(fresh.isConfigured());
      }
    } finally {
      process.env = saved;
      jest.resetModules();
    }
  });
});
