// src/lib/loginEvents.js
//
// Records one row per authentication attempt, for the Security Centre.
//
// ── The one rule ─────────────────────────────────────────────────────────────
//
// THIS MUST NEVER BREAK A LOGIN. Every function here swallows its own errors
// and returns; none of them is awaited by the auth routes. Observability that
// can lock users out of the product is worse than no observability, and the
// failure mode would be invisible until the day the table filled up or a
// constraint changed. The existing `last_login` update takes the same posture,
// for the same reason.
'use strict';

const logger = require('./logger');

const OUTCOMES = {
  SUCCESS: 'success',
  BAD_PASSWORD: 'bad_password',
  UNKNOWN_USER: 'unknown_user',
  INACTIVE: 'inactive',
  MFA_REQUIRED: 'mfa_required',
  MFA_FAILED: 'mfa_failed',
  // Right password, wrong sign-in page: a client on Admin Login, or a studio
  // account on Member Login. Kept distinct from bad_password because it is not
  // a failed credential — lumping the two together would make an ordinary
  // mix-up look like an attack in the audit trail.
  WRONG_PORTAL: 'wrong_portal',
};

/**
 * Client IP, preferring Express's own resolution.
 *
 * `req.ip` already honours the trust-proxy setting the app configures, which
 * is the only trustworthy source here — reading X-Forwarded-For directly would
 * take whatever the client claimed and record an attacker-chosen address as
 * fact, which is worse than recording nothing.
 */
function clientIp(req) {
  return req?.ip || req?.socket?.remoteAddress || null;
}

/**
 * Write the event. Fire-and-forget by design — callers do not await it.
 *
 * @param {object} req express request (for ip + user agent)
 * @param {object} e
 * @param {string} e.outcome    one of OUTCOMES
 * @param {string} [e.method]   password | google | passkey | refresh
 * @param {string} [e.userId]
 * @param {string} [e.email]    the address that was attempted
 * @param {string} [e.orgId]
 */
function record(req, e) {
  // Required lazily so this module stays importable — and testable — without a
  // database, matching lib/features.js and lib/platformBilling.js.
  let pool;
  try { pool = require('../db/pool'); } catch { return; }

  pool.query(
    `INSERT INTO login_events
       (user_id, email_attempted, organization_id, outcome, method, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      e.userId || null,
      // Lower-cased so grouping by target works however it was capitalised,
      // and capped so a pathological "email" cannot bloat the row.
      e.email ? String(e.email).trim().toLowerCase().slice(0, 320) : null,
      e.orgId || null,
      e.outcome,
      e.method || 'password',
      clientIp(req),
      req?.get?.('user-agent') ? String(req.get('user-agent')).slice(0, 500) : null,
    ]
  ).catch((err) => {
    // Warn, never throw. The caller has already returned a response.
    logger.warn({ err: err.message, outcome: e.outcome }, 'login event write failed (non-critical)');
  });
}

module.exports = { OUTCOMES, record, clientIp };
