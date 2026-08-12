'use strict';

// Mail health has to be readable over HTTP, and it has to tell the truth.
//
// Every send path on this platform hides its own failures by design — the
// forgot-password route must answer identically for a registered and an
// unregistered address, and the approval welcome must not roll back an
// approval it could not announce. So an SMTP outage is invisible until a
// customer reports a missing email. These endpoints are the way to look.
//
// The subtle one is the last group: a send that SMTP accepted and the
// recipient never received is a delivery problem, not a sending problem, and
// the two need completely different fixes. The endpoint must not report the
// first as if it were the second.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const express = require('express');
const request = require('supertest');

jest.mock('../lib/email');
jest.mock('../modules/platform/super-admin/shared', () => ({
  audit: jest.fn().mockResolvedValue(undefined),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const email = require('../lib/email');
const { audit } = require('../modules/platform/super-admin/shared');

function app() {
  const a = express();
  a.use(express.json());
  a.use(require('../modules/platform/super-admin/mail'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /mail/status', () => {
  it('names the missing variables when SMTP is not configured', async () => {
    email.describeConfig.mockReturnValue({ state: 'absent', set: [], missing: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] });

    const res = await request(app()).get('/mail/status').expect(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.reason).toBe('SMTP_NOT_CONFIGURED');
    expect(res.body.data.config.missing).toEqual(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
    // Nothing was attempted, so no connection should have been opened.
    expect(email.verifyConnection).not.toHaveBeenCalled();
  });

  it('calls partial configuration out as sending nothing at all', async () => {
    // The dangerous state: whoever set two of three believes email is on.
    email.describeConfig.mockReturnValue({ state: 'partial', set: ['SMTP_HOST', 'SMTP_USER'], missing: ['SMTP_PASS'] });

    const res = await request(app()).get('/mail/status').expect(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.diagnosis).toMatch(/partially configured/i);
    expect(res.body.data.diagnosis).toContain('SMTP_PASS');
    expect(res.body.data.diagnosis).toMatch(/nothing is sent/i);
  });

  it('reports a verified connection', async () => {
    email.describeConfig.mockReturnValue({ state: 'configured', set: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], missing: [] });
    email.verifyConnection.mockResolvedValue({ ok: true, host: 'smtp.hostinger.com', port: 465, user: 'support@x.com', from: 'support@x.com' });

    const res = await request(app()).get('/mail/status').expect(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.host).toBe('smtp.hostinger.com');
  });

  it('passes the diagnosis through when the credentials are rejected', async () => {
    email.describeConfig.mockReturnValue({ state: 'configured', set: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], missing: [] });
    email.verifyConnection.mockResolvedValue({
      ok: false, reason: 'EAUTH', message: 'Invalid login', diagnosis: 'The host accepted the connection but rejected the credentials.',
    });

    const res = await request(app()).get('/mail/status').expect(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.reason).toBe('EAUTH');
    expect(res.body.data.diagnosis).toMatch(/rejected the credentials/);
  });

  it('never returns the SMTP password', async () => {
    process.env.SMTP_PASS = 'hunter2-should-never-appear';
    email.describeConfig.mockReturnValue({ state: 'configured', set: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], missing: [] });
    email.verifyConnection.mockResolvedValue({ ok: true, host: 'h', port: 465, user: 'u@x.com', from: 'u@x.com' });

    const res = await request(app()).get('/mail/status').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('hunter2-should-never-appear');
    delete process.env.SMTP_PASS;
  });
});

describe('POST /mail/test', () => {
  it('rejects a malformed address before opening a connection', async () => {
    email.isConfigured.mockReturnValue(true);

    const res = await request(app()).post('/mail/test').send({ to: 'not-an-address' }).expect(400);
    expect(res.body.error.code).toBe('INVALID');
    expect(email.sendWithRetry).not.toHaveBeenCalled();
  });

  it('refuses when SMTP is not configured, and says what is missing', async () => {
    email.isConfigured.mockReturnValue(false);
    email.describeConfig.mockReturnValue({ state: 'partial', set: ['SMTP_HOST'], missing: ['SMTP_USER', 'SMTP_PASS'] });

    const res = await request(app()).post('/mail/test').send({ to: 'a@b.com' }).expect(503);
    expect(res.body.error.code).toBe('SMTP_NOT_CONFIGURED');
    expect(res.body.error.message).toContain('SMTP_USER');
  });

  it('uses sendWithRetry, not sendRaw', async () => {
    // sendRaw catches its own errors and returns {sent:false, reason} with the
    // SMTP code, response and envelope result thrown away. That is correct for
    // callers that must not fail because mail did — and it would make this
    // endpoint's entire diagnosis dead code.
    email.isConfigured.mockReturnValue(true);
    email.verifyConnection.mockResolvedValue({ ok: true, from: 'support@x.com' });
    email.sendWithRetry.mockResolvedValue({ accepted: ['a@b.com'], rejected: [], response: '250 OK', messageId: '<1@x>' });

    await request(app()).post('/mail/test').send({ to: 'a@b.com' }).expect(200);
    expect(email.sendWithRetry).toHaveBeenCalled();
    expect(email.sendRaw).not.toHaveBeenCalled();
  });

  it('returns the SMTP dialogue on success', async () => {
    email.isConfigured.mockReturnValue(true);
    email.verifyConnection.mockResolvedValue({ ok: true, from: 'support@x.com' });
    email.sendWithRetry.mockResolvedValue({ accepted: ['a@b.com'], rejected: [], response: '250 OK', messageId: '<1@x>' });

    const res = await request(app()).post('/mail/test').send({ to: 'a@b.com' }).expect(200);
    expect(res.body.data.sent).toBe(true);
    expect(res.body.data.accepted).toEqual(['a@b.com']);
    expect(res.body.data.response).toBe('250 OK');
    // The whole point: an accepted message that never lands is a DELIVERY
    // problem, and the response must not let that read as "it worked".
    expect(res.body.data.note).toMatch(/delivery/i);
    expect(res.body.data.note).toMatch(/SPF|DKIM|DMARC/);
  });

  it('reports a send failure as a diagnosis rather than a 500', async () => {
    email.isConfigured.mockReturnValue(true);
    email.verifyConnection.mockResolvedValue({ ok: true, from: 'support@x.com' });
    const err = Object.assign(new Error('No route to host'), { code: 'ENETUNREACH' });
    email.sendWithRetry.mockRejectedValue(err);
    email.diagnose.mockReturnValue('No route over IPv6 — the transport should pin family: 4.');

    const res = await request(app()).post('/mail/test').send({ to: 'a@b.com' }).expect(200);
    expect(res.body.data.sent).toBe(false);
    expect(res.body.data.reason).toBe('ENETUNREACH');
    expect(res.body.data.diagnosis).toMatch(/family: 4/);
  });

  it('audits the attempt with the right argument positions', async () => {
    // audit(req, action, entityType, entityId, data). Passing the payload
    // third puts an object where a string column goes and silently loses it.
    email.isConfigured.mockReturnValue(true);
    email.verifyConnection.mockResolvedValue({ ok: true, from: 'support@x.com' });
    email.sendWithRetry.mockResolvedValue({ accepted: ['a@b.com'], rejected: [], response: '250 OK' });

    await request(app()).post('/mail/test').send({ to: 'a@b.com' }).expect(200);
    expect(audit).toHaveBeenCalledWith(
      expect.anything(), 'mail_test_sent', 'mail', null, { to: 'a@b.com' },
    );
  });
});
