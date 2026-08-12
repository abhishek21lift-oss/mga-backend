'use strict';
// What outbound mail says about who sent it, under three configurations.
//
// The leakage scan next door is static: it proves a forbidden string is not
// written in the source. It cannot prove that an unconfigured deployment
// produces safe output, because the dangerous value there was never a literal
// in the template — it was the right-hand side of a `||`. This file exercises
// the generators instead.
//
// Case B is the one that matters. A deployment that has not set SUPPORT_EMAIL
// must omit the contact line, not fall back to anything, and must not crash
// while doing it — an exception in template rendering fails the invitation
// send, which is the one email a new studio owner cannot proceed without.

const TEMPLATE_MODULES = [
  '../lib/emailTemplates/invitation',
  '../lib/emailTemplates/clientActivation',
];

const ARGS = {
  ownerName: 'Priya',
  clientName: 'Priya Nair',
  studioName: 'Northside Strength',
  email: 'priya@example.com',
  actionUrl: 'https://app.example.com/activate?token=abc',
  expiryHours: 48,
};

/** Re-require the templates so siteIdentity re-reads the current env. */
function render() {
  jest.resetModules();
  const invitation = require('../lib/emailTemplates/invitation');
  const activation = require('../lib/emailTemplates/clientActivation');
  return [
    invitation.invitationHtml(ARGS),
    invitation.invitationText(ARGS),
    activation.clientActivationHtml(ARGS),
    activation.clientActivationText(ARGS),
  ];
}

const OLD_IDENTIFIERS = [/myptstudio/i, /619fitness/i, /8756562188/];

describe('outbound mail carries only configured identity', () => {
  const saved = { name: process.env.SITE_NAME, email: process.env.SUPPORT_EMAIL };

  afterEach(() => {
    if (saved.name === undefined) delete process.env.SITE_NAME;
    else process.env.SITE_NAME = saved.name;
    if (saved.email === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved.email;
  });

  test('Case A — fully configured: only the new identity appears', () => {
    process.env.SITE_NAME = 'Northside OS';
    process.env.SUPPORT_EMAIL = 'help@northside.example';

    for (const out of render()) {
      expect(out).toContain('Northside OS');
      expect(out).toContain('help@northside.example');
      for (const old of OLD_IDENTIFIERS) expect(out).not.toMatch(old);
    }
  });

  test('Case B — no support address: the contact line is omitted, nothing substituted', () => {
    process.env.SITE_NAME = 'Northside OS';
    delete process.env.SUPPORT_EMAIL;

    const outputs = render(); // must not throw
    for (const out of outputs) {
      expect(out).toContain('Northside OS');
      // No support address — not the old one, not a placeholder, not "null".
      //
      // The recipient's OWN address is excluded first: the invitation prints
      // it on purpose, to confirm which mailbox the account logs in with,
      // which is the detail people get wrong when an invite is forwarded.
      // Asserting "no email addresses at all" would forbid that and test the
      // wrong thing.
      const withoutRecipient = out.split(ARGS.email).join('');
      expect(withoutRecipient).not.toMatch(/mailto:/);
      expect(withoutRecipient).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(out).not.toMatch(/\bnull\b|\bundefined\b/);
      for (const old of OLD_IDENTIFIERS) expect(out).not.toMatch(old);
    }
  });

  test('Case C — nothing configured: renders, and still names no support contact', () => {
    delete process.env.SITE_NAME;
    delete process.env.SUPPORT_EMAIL;

    const outputs = render(); // must not throw
    for (const out of outputs) {
      expect(out.length).toBeGreaterThan(200);
      expect(out).not.toMatch(/mailto:/);
      expect(out).not.toMatch(/\bnull\b|\bundefined\b/);
      // The brand name still defaults to the original product — that is the
      // documented behaviour of siteIdentity.siteName(), so that extracting
      // these values changed nothing for the repository they came from. It is
      // asserted here rather than left implicit: if the default is ever
      // changed to something neutral, this is the test that should be updated
      // deliberately rather than a surprise in someone's inbox.
      expect(out).toMatch(/MY.{0,6}PT.{0,6}STUDIO/i);
      // But never a way to CONTACT the original company.
      expect(out).not.toMatch(/myptstudio\.com|619fitness/i);
      expect(out).not.toMatch(/8756562188/);
    }
  });

  test('the templates under test are the real ones', () => {
    // Guards against a rename quietly turning every assertion above into a
    // test of nothing.
    for (const m of TEMPLATE_MODULES) expect(() => require(m)).not.toThrow();
  });
});
