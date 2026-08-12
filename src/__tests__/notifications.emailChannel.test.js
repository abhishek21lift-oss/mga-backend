// The notification centre's email channel had its own, second copy of the
// SMTP setup — independent of lib/email.js, which is the hardened,
// well-tested path everything else in the app sends through. Two bugs came
// from that duplication:
//
//   1. Its "secure" flag came from SMTP_SECURE, a variable nothing in
//      .env.example ever told anyone to set. lib/email.js has
//      always derived it correctly from the port (secure = port === 465).
//      On Hostinger port 465, that mismatch means this channel never worked.
//   2. When NEITHER Resend nor SMTP was configured, it returned
//      status: 'sent' with a fake provider_id — indistinguishable from a
//      real send anywhere this result is read (notification_log, a caller
//      checking res.email.status). That is a silent, undetectable failure
//      mode by construction.
//
// Fixed by delegating to lib/email.js's transporter (single source of truth)
// and reporting 'not_configured' honestly, matching the other channels
// (whatsapp/sms/push) which already did this correctly.
'use strict';

jest.mock('../lib/email', () => ({
  sendRaw: jest.fn(),
}));

const emailLib = require('../lib/email');
const { channels } = require('../modules/notifications/notifications.service');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.clearAllMocks();
});

describe('notifications email channel', () => {
  test('reports not_configured (never a fake "sent") when no provider is set up', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const result = await channels.email({ to: 'studio@example.com', subject: 'Hi', html: '<p>hi</p>' });

    expect(result.status).toBe('not_configured');
    expect(emailLib.sendRaw).not.toHaveBeenCalled();
  });

  test('delegates to lib/email.js sendRaw when SMTP is configured, not a second transporter', async () => {
    process.env.SMTP_HOST = 'smtp.hostinger.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'support@myptstudio.com';
    process.env.SMTP_PASS = 'secret';
    delete process.env.RESEND_API_KEY;
    emailLib.sendRaw.mockResolvedValue({ sent: true, messageId: 'msg-1' });

    const result = await channels.email({ to: 'studio@example.com', subject: 'Hi', html: '<p>hi</p>' });

    expect(emailLib.sendRaw).toHaveBeenCalledWith(
      { to: 'studio@example.com', subject: 'Hi', html: '<p>hi</p>' },
      expect.objectContaining({ to: 'studio@example.com' })
    );
    expect(result).toEqual({ status: 'sent', provider_id: 'msg-1' });
  });

  test('a real SMTP failure is reported as failed, not silently upgraded to sent', async () => {
    process.env.SMTP_HOST = 'smtp.hostinger.com';
    process.env.SMTP_USER = 'support@myptstudio.com';
    process.env.SMTP_PASS = 'secret';
    delete process.env.RESEND_API_KEY;
    emailLib.sendRaw.mockResolvedValue({ sent: false, reason: 'EAUTH' });

    const result = await channels.email({ to: 'studio@example.com', subject: 'Hi', html: '<p>hi</p>' });

    expect(result).toEqual({ status: 'failed', error: 'EAUTH' });
  });

  test('a missing recipient fails before any provider is touched', async () => {
    const result = await channels.email({ subject: 'Hi', html: '<p>hi</p>' });
    expect(result).toEqual({ status: 'failed', error: 'no recipient' });
    expect(emailLib.sendRaw).not.toHaveBeenCalled();
  });
});
