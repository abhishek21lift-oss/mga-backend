// The From-address fallback used when SMTP_FROM is not set.
//
// This used to be a hardcoded 'noreply@619fitness.com' — a domain with no DNS
// records at all. Hostinger (and any relay) rejects the envelope outright
// when the From domain doesn't match the authenticated mailbox's domain, so
// every password reset and admin-reset OTP would fail at send time even
// though SMTP_HOST/USER/PASS were all correctly configured — the boot check
// would report "configured" while sending was actually broken. Falling back
// to SMTP_USER instead guarantees a From address the mailbox can always send
// as, since it IS the authenticated identity.
'use strict';

jest.mock('nodemailer');

const ORIGINAL_ENV = { ...process.env };
const sendMail = jest.fn(async () => ({ messageId: 'msg-1' }));

// jest.resetModules() clears the require cache, so a fresh require('nodemailer')
// after it is a NEW automock instance — mocking createTransport on a reference
// obtained before resetModules would silently mock the wrong object. Both
// requires below happen in the same post-reset registry epoch, so lib/email.js
// resolves 'nodemailer' to the exact instance just configured here.
function loadEmailLib(env) {
  process.env = { ...ORIGINAL_ENV, ...env };
  jest.resetModules();
  const nodemailer = require('nodemailer');
  nodemailer.createTransport = jest.fn(() => ({ sendMail }));
  return require('../lib/email');
}

beforeEach(() => {
  sendMail.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

describe('FROM_ADDR fallback', () => {
  test('sends password resets from SMTP_FROM when it is set', async () => {
    const email = loadEmailLib({
      SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'support@myptstudio.com',
      SMTP_PASS: 'x', SMTP_FROM: 'no-reply@myptstudio.com',
    });
    await email.sendPasswordReset('user@example.com', 'tok');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'no-reply@myptstudio.com' }));
  });

  test('falls back to SMTP_USER (never a hardcoded domain) when SMTP_FROM is unset', async () => {
    const email = loadEmailLib({
      SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'support@myptstudio.com', SMTP_PASS: 'x',
    });
    delete process.env.SMTP_FROM;
    await email.sendPasswordReset('user@example.com', 'tok');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'support@myptstudio.com' }));
    expect(sendMail.mock.calls[0][0].from).not.toMatch(/619fitness/);
  });

  test('the same fallback applies to the admin reset OTP', async () => {
    const email = loadEmailLib({
      SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'support@myptstudio.com', SMTP_PASS: 'x',
    });
    delete process.env.SMTP_FROM;
    await email.sendAdminResetOtp('user@example.com', '123456');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'support@myptstudio.com' }));
  });

  test('sendRaw (the notification channel path) uses the same fallback', async () => {
    const email = loadEmailLib({
      SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: 'support@myptstudio.com', SMTP_PASS: 'x',
    });
    delete process.env.SMTP_FROM;
    await email.sendRaw({ to: 'user@example.com', subject: 'Hi', html: '<p>hi</p>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'support@myptstudio.com' }));
  });
});
