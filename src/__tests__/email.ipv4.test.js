// The transport must connect over IPv4, and why that is not a preference.
//
// No mail left the deploy for days. The boot verification failed on port 587
// with:
//
//   ESOCKET  connect ENETUNREACH 2606:4700:90:0:f225:a1af:129b:4ba1:587
//            - Local (:::0)
//
// smtp.hostinger.com publishes both an AAAA (that 2606:4700:… address) and an
// A (172.65.255.143), and the deploy reached for the AAAA. The container has
// no IPv6 route, so the attempt died before TLS or AUTH was ever reached.
// "Local (:::0)" is the tell — no local IPv6 address to source the connection
// from.
//
// Worth knowing when reading this: the failure does not reproduce on a host
// whose resolver already prefers IPv4, which most development machines do.
// The option cannot be validated by connecting from somewhere it was never
// going to fail, which is why these tests assert on the transport options.
//
// Port 465 failed the same way and merely looked different (ETIMEDOUT rather
// than ENETUNREACH), which is why switching ports repeatedly appeared to do
// nothing. Nothing was wrong with the host, the credentials, the TLS pairing
// or DNS.
//
// family: 4 is one line and invisible, so it is exactly the kind of thing a
// later refactor drops while everything still passes — hence a test that
// asserts on the options handed to nodemailer rather than on behaviour.
'use strict';
jest.mock('nodemailer');
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORIGINAL = { ...process.env };
const CFG = {
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_USER: 'support@myptstudio.com',
  SMTP_PASS: 'x',
};

function load(env = {}) {
  process.env = { ...ORIGINAL, ...CFG, ...env };
  jest.resetModules();
  const nm = require('nodemailer');
  nm.createTransport = jest.fn(() => ({ verify: jest.fn(async () => true), sendMail: jest.fn(async () => ({})) }));
  return { email: require('../lib/email'), nm };
}

afterEach(() => { process.env = { ...ORIGINAL }; jest.resetModules(); });

describe('SMTP transport address family', () => {
  test('pins IPv4', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' });
    await email.verifyConnection();
    expect(nm.createTransport).toHaveBeenCalledTimes(1);
    expect(nm.createTransport.mock.calls[0][0]).toMatchObject({ family: 4 });
  });

  test('pins IPv4 on 465 too — the failure was never about the port', () => {
    // Both ports resolve the same hostname to the same unreachable AAAA
    // record, so fixing only the configured one fixes nothing the day
    // somebody switches.
    const { email, nm } = load({ SMTP_PORT: '465' });
    email.verifyConnection();
    expect(nm.createTransport.mock.calls[0][0]).toMatchObject({ family: 4, port: 465, secure: true });
  });

  test('still pairs 587 with STARTTLS and 465 with implicit TLS', () => {
    // Guards against "fixing" this by forcing secure alongside family.
    const a = load({ SMTP_PORT: '587' });
    a.email.verifyConnection();
    expect(a.nm.createTransport.mock.calls[0][0]).toMatchObject({ port: 587, secure: false });

    const b = load({ SMTP_PORT: '465' });
    b.email.verifyConnection();
    expect(b.nm.createTransport.mock.calls[0][0]).toMatchObject({ port: 465, secure: true });
  });
});

describe('diagnose() on an unreachable IPv6 address', () => {
  test('names IPv6 rather than blaming a blocked port', async () => {
    // The previous diagnosis caught ESOCKET and confidently said "some hosts
    // block outbound SMTP entirely", which is what sent this investigation
    // after the port instead of the address family. A wrong diagnosis is
    // worse than none — it is followed.
    const { email, nm } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(
          new Error('connect ENETUNREACH 2606:4700:90:0:f225:a1af:129b:4ba1:587 - Local (:::0)'),
          { code: 'ESOCKET' },
        );
      }),
    });

    const r = await email.verifyConnection();
    expect(r.ok).toBe(false);
    expect(r.diagnosis).toMatch(/IPv6/);
    expect(r.diagnosis).not.toMatch(/block outbound SMTP/);
  });

  test('a genuine ENETUNREACH without an IPv6 address is not called IPv6', async () => {
    const { email, nm } = load({ SMTP_PORT: '587' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(new Error('connect ENETUNREACH 172.65.255.143:587'), { code: 'ENETUNREACH' });
      }),
    });

    const r = await email.verifyConnection();
    expect(r.diagnosis).toMatch(/No route/);
    expect(r.diagnosis).not.toMatch(/IPv6/);
  });

  test('a real timeout on an IPv4 address still reads as a port problem', async () => {
    // The port diagnosis is still correct for the case it was written for.
    const { email, nm } = load({ SMTP_PORT: '465' });
    nm.createTransport.mockReturnValue({
      verify: jest.fn(async () => {
        throw Object.assign(new Error('connect ETIMEDOUT 172.65.255.143:465'), { code: 'ETIMEDOUT' });
      }),
    });

    const r = await email.verifyConnection();
    expect(r.diagnosis).toMatch(/port 465|block outbound/i);
  });
});
