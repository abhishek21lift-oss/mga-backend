'use strict';
// Verifies the `X-Service-Auth` header presented by first-party services.
//
// Today that is one caller: the MY PT STUDIO AI service (repo: mps-ai). It
// forwards the END USER's JWT in Authorization — which is what `auth()`
// resolves into a user, an organisation and a role — and adds this header to
// say "and the relay was me, not the open internet".
//
// ── What this does NOT do ────────────────────────────────────────────────────
//
// It grants nothing. A valid service header does not widen what the request may
// read, does not skip `auth()`, and does not bypass tenantScope(). Anyone
// holding a user's token could already call these endpoints directly; the AI
// service has no privilege to add. Treating this header as an authorisation
// input would invert that and turn a shared secret into a way to act as
// somebody — exactly what forwarding the user's token exists to avoid.
//
// So it is an ATTESTATION, not a credential, and it is deliberately optional:
// requiring it globally would break the browser, the mobile clients and every
// existing integration, which present no such header and must keep working.
//
// ── Why reject a wrong one instead of ignoring it ────────────────────────────
//
// Ignoring a bad header would make the check pointless in the direction that
// matters: rotate SERVICE_AUTH_SECRET on the ERP and forget the AI service, and
// every AI request would keep succeeding while silently losing its attestation.
// The tag would rot to "usually true", and the audit trail built on it would
// quietly become fiction. Failing loudly turns a rotation mistake into a
// visible outage on the next request rather than a slow drift nobody notices.
//
// Fail-closed on missing configuration for the same reason: if the header is
// presented but the ERP has no secret to check it against, that is a half-
// configured deploy, and answering "fine" to an unverifiable claim is worse
// than answering "no".

const crypto = require('crypto');
const logger = require('../lib/logger');

const HEADER = 'x-service-auth';

/**
 * Constant-time compare that does not leak length either.
 *
 * timingSafeEqual throws on a length mismatch, and returning early on that
 * throw would leak the secret's length through response timing — enough to
 * narrow a brute force. Hashing both sides first makes every comparison run
 * over 32 bytes regardless of what was presented.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Express middleware. Mount BEFORE `auth` so a forged attestation is refused
 * before any user lookup happens.
 *
 * Sets `req.serviceCaller = 'ai'` when a valid header is present, so routes and
 * audit logging can tell an AI-relayed request from a browser one. Absent
 * header → untouched, request proceeds as a normal client.
 */
function serviceAuth(req, res, next) {
  const presented = req.headers[HEADER];

  // The overwhelmingly common case: a browser, with no such header.
  if (presented == null || presented === '') return next();

  const expected = process.env.SERVICE_AUTH_SECRET;
  if (!expected) {
    logger.error({ path: req.path }, 'service_auth_not_configured');
    return res.status(503).json({
      error: {
        code: 'SERVICE_AUTH_NOT_CONFIGURED',
        message: 'Service authentication is not configured on this server.',
      },
    });
  }

  if (!safeEqual(presented, expected)) {
    // Never log the presented value — a near-miss is the most useful thing an
    // attacker could have written into your log file.
    logger.warn({ path: req.path, ip: req.ip }, 'service_auth_rejected');
    return res.status(401).json({
      error: { code: 'SERVICE_AUTH_INVALID', message: 'Invalid service credential.' },
    });
  }

  req.serviceCaller = 'ai';
  return next();
}

module.exports = { serviceAuth, safeEqual, HEADER };
