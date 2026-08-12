// verifyConnection() — proves the credentials without sending anything.
'use strict';
jest.mock('nodemailer');
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ORIGINAL = { ...process.env };
function load(env) {
  process.env = { ...ORIGINAL, ...env };
  jest.resetModules();
  const nm = require('nodemailer');
  nm.createTransport = jest.fn(() => ({ verify: env.__verify }));
  return require('../lib/email');
}
afterEach(() => { process.env = { ...ORIGINAL }; jest.resetModules(); });

const CFG = { SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '587', SMTP_USER: 'support@myptstudio.com', SMTP_PASS: 'x' };

describe('verifyConnection', () => {
  test('reports ok with the settings actually in use', async () => {
    const email = load({ ...CFG, __verify: jest.fn(async () => true) });
    const r = await email.verifyConnection();
    expect(r).toMatchObject({ ok: true, host: 'smtp.hostinger.com', port: 587, from: 'support@myptstudio.com' });
  });

  test('rejected credentials come back with an actionable diagnosis, not just a code', async () => {
    const email = load({ ...CFG, __verify: jest.fn(async () => {
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', response: '535 auth failed' });
    }) });
    const r = await email.verifyConnection();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('EAUTH');
    expect(r.diagnosis).toMatch(/MAILBOX password|must actually exist/i);
  });

  test('a blocked or wrong port is diagnosed as such', async () => {
    const email = load({ ...CFG, __verify: jest.fn(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    }) });
    const r = await email.verifyConnection();
    expect(r.diagnosis).toMatch(/port 587|block outbound/i);
  });

  test('never throws — startup must not die because mail is misconfigured', async () => {
    const email = load({ ...CFG, __verify: jest.fn(async () => { throw new Error('boom'); }) });
    await expect(email.verifyConnection()).resolves.toMatchObject({ ok: false });
  });

  test('unconfigured SMTP is reported without attempting a connection', async () => {
    const email = load({ SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', __verify: jest.fn() });
    const r = await email.verifyConnection();
    expect(r).toMatchObject({ ok: false, reason: 'SMTP_NOT_CONFIGURED' });
    expect(r.missing).toEqual(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
  });
});
