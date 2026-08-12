'use strict';

/**
 * Mail health, visible without a shell on the box.
 *
 * Every outgoing message this platform sends is invisible when it fails.
 * /auth/forgot-password must answer identically whether or not an address is
 * registered, so it cannot report a send failure; invitations and the
 * approval welcome swallow theirs so a mail outage does not roll back an
 * approval that already committed. The result is that a dead mailbox looks
 * exactly like a working one until a customer says they never got the email.
 *
 * server.js already proves the credentials at boot and logs the answer. That
 * only helps somebody who can read the container's stdout — after the move to
 * a VPS that means SSH, docker compose, and knowing to look. So the same two
 * questions are answered over HTTP here:
 *
 *   GET  /mail/status  — is it configured, and do the credentials work?
 *   POST /mail/test    — does a real message actually reach a real inbox?
 *
 * Both are super-admin only (the parent router carries auth, requireSuperAdmin
 * and the MFA gate), and neither ever returns SMTP_PASS.
 *
 * The two are separate on purpose. `verify()` opens a session and authenticates
 * without sending, so a green status with an empty inbox is itself the finding:
 * it rules out host, port, TLS and credentials in one shot and points at the
 * envelope, the provider's outbound filtering, or the receiving side. Only a
 * real send can distinguish those, and only a real send can be checked against
 * a real Gmail account — which is where the reports come from.
 */

const router = require('express').Router();
const { audit, logger } = require('./shared');
const email = require('../../../lib/email');
const { siteName } = require('../../../lib/siteIdentity');

/** Never let SMTP_PASS reach a response body, whatever else is added later. */
function safeConfig() {
  const cfg = email.describeConfig();
  return {
    state: cfg.state,          // configured | partial | absent
    set: cfg.set,              // which of the three required vars are present
    missing: cfg.missing,      // and which are not
  };
}

// ── GET /mail/status ─────────────────────────────────────────────────────────
//
// Answers "should mail work?" without sending anything. `partial` is called
// out separately from `absent` because it is the more dangerous state: two of
// three variables set reads as "I configured email" to whoever set them, and
// sends nothing at all.
router.get('/mail/status', async (req, res, next) => {
  try {
    const config = safeConfig();
    if (config.state !== 'configured') {
      return res.json({
        data: {
          ok: false,
          config,
          reason: 'SMTP_NOT_CONFIGURED',
          diagnosis: config.state === 'partial'
            ? `SMTP is partially configured — ${config.missing.join(', ')} still missing — so nothing is sent at all.`
            : 'SMTP is not configured on this deploy, so no outgoing email is attempted.',
        },
      });
    }

    // Never throws; returns the failure as data with a diagnosis attached.
    const result = await email.verifyConnection();
    res.json({ data: { ...result, config } });
  } catch (err) { next(err); }
});

// ── POST /mail/test ──────────────────────────────────────────────────────────
//
// Sends one real message and reports exactly what the SMTP server said.
//
// This is the only check that covers the whole path. A relay can accept the
// credentials and still refuse the envelope, or accept the message and have
// the receiving side drop it for SPF/DKIM/DMARC reasons — in which case the
// response here is a clean 250 with a message id, and the absence of the mail
// at the other end proves the problem is delivery, not sending. Those two look
// identical from the application's side and need completely different fixes,
// so the distinction is worth a button.
router.post('/mail/test', async (req, res) => {
  const to = String(req.body?.to || '').trim();
  await audit(req, 'mail_test_sent', 'mail', null, { to }).catch(() => {});

  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({
        error: { code: 'INVALID', message: 'A valid destination address is required.' },
      });
    }
    if (!email.isConfigured()) {
      return res.status(503).json({
        error: {
          code: 'SMTP_NOT_CONFIGURED',
          message: `SMTP is not configured on this deploy (missing: ${safeConfig().missing.join(', ')}).`,
        },
      });
    }

    const stamp = new Date().toISOString();
    // sendWithRetry, not sendRaw: sendRaw catches its own errors and returns
    // {sent:false, reason} with the SMTP code, response and envelope result
    // discarded. That is right for a caller that must not fail because mail
    // did, and useless here — the dialogue IS the diagnosis. This one throws,
    // and returns nodemailer's full info object.
    const info = await email.sendWithRetry({
      from: (await email.verifyConnection()).from,
      to,
      subject: `${siteName()} — mail test ${stamp}`,
      html: `<p>This is a test message from the MY PT STUDIO Command Centre.</p>
             <p>If you are reading it, outgoing mail works: SMTP accepted the message
             and the receiving server delivered it.</p>
             <p style="color:#64748B;font-size:12px">Sent ${stamp}</p>`,
      text: `This is a test message from the MY PT STUDIO Command Centre.\n\n`
          + `If you are reading it, outgoing mail works: SMTP accepted the message and `
          + `the receiving server delivered it.\n\nSent ${stamp}`,
    }, { reason: 'mail_test' });

    logger.info({ to, messageId: info?.messageId }, 'mail test sent');
    res.json({
      data: {
        sent: true,
        to,
        // `accepted`/`rejected` come straight from the SMTP dialogue. An
        // address in `rejected` with no thrown error is the case that would
        // otherwise read as success.
        accepted: info?.accepted ?? [],
        rejected: info?.rejected ?? [],
        response: info?.response ?? null,
        messageId: info?.messageId ?? null,
        note: 'SMTP accepted this message. If it never arrives, the problem is '
            + 'delivery (SPF/DKIM/DMARC, or the recipient filing it as spam), not sending.',
      },
    });
  } catch (err) {
    // A failed test is a successful diagnosis, so it is 200-with-data rather
    // than an error status: the caller asked "what is wrong", and the answer
    // is the body. Errors here are expected output, not exceptions.
    logger.warn({ to, err: err.message, code: err.code }, 'mail test failed');
    res.json({
      data: {
        sent: false,
        to,
        reason: err.code || 'ERROR',
        message: err.message,
        response: err.response ?? null,
        diagnosis: email.diagnose(err),
      },
    });
  }
});

module.exports = router;
