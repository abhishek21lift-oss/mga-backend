const { frontendBase, frontendUrl } = require('../lib/frontendUrl');

describe('frontendUrl', () => {
  const original = process.env.FRONTEND_URL;
  afterEach(() => { process.env.FRONTEND_URL = original; });

  it('strips a trailing slash', () => {
    // This is the value actually stored in production — pasted from a browser
    // address bar, which appends the slash. Concatenating a path onto it gave
    // "https://www.619fitnessstudio.com//reset-password".
    process.env.FRONTEND_URL = 'https://www.619fitnessstudio.com/';
    expect(frontendUrl('/reset-password?token=abc'))
      .toBe('https://www.619fitnessstudio.com/reset-password?token=abc');
  });

  it('strips several trailing slashes', () => {
    process.env.FRONTEND_URL = 'https://example.com///';
    expect(frontendBase()).toBe('https://example.com');
  });

  it('leaves a clean URL alone', () => {
    process.env.FRONTEND_URL = 'https://example.com';
    expect(frontendUrl('/settings/integrations'))
      .toBe('https://example.com/settings/integrations');
  });

  it('tolerates a path without a leading slash', () => {
    process.env.FRONTEND_URL = 'https://example.com/';
    expect(frontendUrl('settings')).toBe('https://example.com/settings');
  });

  it('trims surrounding whitespace', () => {
    // Copy-paste into a dashboard field picks these up invisibly.
    process.env.FRONTEND_URL = '  https://example.com/  ';
    expect(frontendBase()).toBe('https://example.com');
  });

  it('returns an empty string when unset rather than "undefined"', () => {
    // A literal "undefined/reset-password" in an email would be worse than
    // an obviously broken empty link.
    delete process.env.FRONTEND_URL;
    expect(frontendBase()).toBe('');
    expect(frontendUrl('/x')).toBe('/x');
  });
});
