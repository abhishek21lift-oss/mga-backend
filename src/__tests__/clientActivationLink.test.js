// The link in the client activation email.
//
// This is the whole feature reduced to one string. Everything else can be
// correct — the account created, the token issued, the email delivered — and
// if the URL points at the wrong host, or carries a doubled slash, or 404s,
// the client cannot get in and the only symptom is a person saying "the link
// doesn't work".
//
// It is tested separately because it already went wrong once. The first
// version read `process.env.APP_URL || FRONTEND_URL || 'https://myptstudio.com'`
// and APP_URL is set nowhere: docker-compose passes only FRONTEND_URL, and
// APP_URL appeared in exactly one file in the repo — that one. So it always
// fell through to the hardcoded default. That default happens to be the right
// domain in production today, which is precisely what makes the bug nasty: it
// works, until it is deployed anywhere else.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const { clientActivationHtml, clientActivationText } = require('../lib/emailTemplates/clientActivation');

/** Reload frontendUrl with a given env, since it reads process.env per call. */
function urlFor(frontendEnv, path) {
  const prev = process.env.FRONTEND_URL;
  if (frontendEnv === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = frontendEnv;
  try {
    return require('../lib/frontendUrl').frontendUrl(path);
  } finally {
    if (prev === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = prev;
  }
}

describe('where the activation link points', () => {
  const PATH = '/client/activate?token=abc123';

  it('is built from FRONTEND_URL — the variable the deployment actually sets', () => {
    expect(urlFor('https://myptstudio.com', PATH))
      .toBe('https://myptstudio.com/client/activate?token=abc123');
  });

  it('follows a staging deployment instead of hardcoding production', () => {
    // The half the original bug got wrong. A staging box would have emailed
    // real clients a link to the live site.
    expect(urlFor('https://staging.myptstudio.com', PATH))
      .toBe('https://staging.myptstudio.com/client/activate?token=abc123');
  });

  it('survives a trailing slash on the configured value', () => {
    // "https://example.com/" is what you get pasting out of an address bar,
    // and is how it has been set in production before. A doubled slash either
    // 404s or silently redirects depending on the host.
    expect(urlFor('https://myptstudio.com/', PATH))
      .toBe('https://myptstudio.com/client/activate?token=abc123');
    expect(urlFor('https://myptstudio.com///', PATH))
      .not.toContain('com//client');
  });

  it('matches the path the frontend actually serves', () => {
    // src/app/client/activate/page.tsx. If either side is renamed without the
    // other, every activation email 404s and nothing else fails.
    expect(urlFor('https://x.com', PATH)).toContain('/client/activate?token=');
  });

  it('is built by the route through frontendUrl, not a hand-rolled env read', () => {
    // The four assertions above all pass with the original bug still in
    // place, because they exercise the helper rather than its caller. That
    // was the first version of this suite and it was worthless: the defect
    // was never in frontendUrl, it was in client-login.js not calling it.
    //
    // Reading the source is the only way to pin "the caller uses the shared
    // helper" without a live SMTP server. The repo does the same thing in
    // rls.convention.test.js for the same reason.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'client-login.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

    expect(code).toMatch(/frontendUrl\(\s*`\/client\/activate\?token=/);
    // APP_URL is set by no deployment — docker-compose passes FRONTEND_URL
    // only — so any read of it silently falls through to a default.
    expect(code).not.toMatch(/process\.env\.APP_URL/);
    // And no second copy of the base URL, however it is spelled.
    expect(code).not.toMatch(/process\.env\.FRONTEND_URL/);
  });
});

describe('the activation email carries the link where a client can reach it', () => {
  const vars = {
    clientName: 'Hari Narayan Singh',
    studioName: 'Abhishek PT Studio',
    actionUrl: 'https://myptstudio.com/client/activate?token=abc123',
    expiryHours: 48,
  };

  it('puts it on the button', () => {
    const html = clientActivationHtml(vars);
    expect(html).toContain(`href="${vars.actionUrl}"`);
  });

  it('also prints it as copyable text, because clients block buttons', () => {
    // Mail clients mangle long links and some strip the anchor entirely. The
    // paste-this fallback is what makes the email work when the button does
    // not — and a client who cannot activate has no other route in.
    const html = clientActivationHtml(vars);
    const occurrences = html.split(vars.actionUrl).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('carries it in the plain-text part too', () => {
    const text = clientActivationText(vars);
    expect(text).toContain(vars.actionUrl);
    expect(text).not.toContain('<');
  });

  it('never contains a password', () => {
    // The rule the whole flow exists for.
    const html = clientActivationHtml(vars).toLowerCase();
    expect(html).not.toMatch(/your password is/);
    expect(html).not.toMatch(/temporary password/);
    expect(clientActivationText(vars).toLowerCase()).not.toMatch(/password is/);
  });

  it('escapes a studio name so it cannot inject markup', () => {
    // studio_name is trainer-entered text landing in an HTML email.
    const html = clientActivationHtml({ ...vars, studioName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('states the expiry the server actually enforces', () => {
    expect(clientActivationHtml(vars)).toContain('48 hours');
    expect(clientActivationText(vars)).toContain('48 hours');
  });
});
