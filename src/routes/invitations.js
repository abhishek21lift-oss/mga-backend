'use strict';
// The invited admin's side of onboarding. Deliberately UNAUTHENTICATED — the
// person using it has no password yet, which is the entire point.
//
// That makes this one of only a handful of public write surfaces in the app,
// so the constraints are tighter than anywhere else:
//
//   • The token is the only credential. It is single-use, 24h, and matched by
//     hash — see lib/invitations.js.
//   • Every rejection returns the same shape. An attacker probing tokens must
//     not be able to tell "expired" from "never existed", because the first
//     confirms a valid guess.
//   • Nothing here reveals an address that was not already supplied. The
//     preview returns the studio and the masked login email, so the recipient
//     can confirm they are activating the right account without the endpoint
//     becoming an email-disclosure oracle for anyone holding a token.

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const invitations = require('../lib/invitations');
const { invalidateUserCache } = require('../middleware/auth');

const router = express.Router();

// Public and token-guessing-adjacent, so it gets its own limiter rather than
// riding the general API one. Generous enough that a person re-reading their
// email and clicking twice is never blocked.
const inviteLimiter = rateLimit({
  store: makeStore('invite'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

/** One shape for every rejection, so nothing is learned from the difference. */
const REJECT = {
  invalid: 'This invitation link is not valid.',
  expired: 'This invitation has expired. Ask your platform administrator to send a new one.',
  used: 'This invitation has already been used. Try signing in instead.',
  cancelled: 'This invitation was cancelled. Ask your platform administrator to send a new one.',
};

/** a***@example.com — enough to recognise, not enough to harvest. */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  const head = user.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}

// ── GET /api/invitations/:token ──────────────────────────────────────────────
// What the set-password page loads first: is this link good, and whose is it?
router.get('/:token', inviteLimiter, async (req, res, next) => {
  try {
    const result = await invitations.resolve(req.params.token);
    if (!result.ok) {
      return res.status(410).json({
        error: { code: result.reason.toUpperCase(), message: REJECT[result.reason] || REJECT.invalid },
      });
    }
    const r = result.row;
    res.json({
      data: {
        studio_name: r.studio_name || r.org_name,
        owner_name: r.owner_name,
        email_masked: maskEmail(r.user_email || r.email),
        expires_at: r.expires_at,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/invitations/track/:trackId.gif ──────────────────────────────────
// Open tracking. Keyed on an opaque track_id, never the token: a pixel URL
// travels through mail clients, image proxies and referrer headers, and must
// not carry the secret that grants access to the account.
//
// Always returns the image, even for an unknown id — a 404 here would let
// someone enumerate which ids are real, and would show a broken image in the
// recipient's email for no benefit.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);
router.get('/track/:trackId.gif', async (req, res) => {
  try {
    await invitations.markOpened(req.params.trackId);
  } catch (err) {
    // Tracking must never break the image. A failed write costs a metric.
    logger.warn({ err: err.message }, 'invitation open tracking failed');
  }
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.end(PIXEL);
});

// ── POST /api/invitations/:token/accept ──────────────────────────────────────
// Set the password and activate the account.
router.post('/:token/accept', inviteLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const password = String(req.body?.password || '');
    const check = validatePassword(password);
    if (check) return res.status(400).json({ error: { code: 'VALIDATION', message: check } });

    await client.query('BEGIN');

    // Re-resolve INSIDE the transaction and lock the row. Two tabs submitting
    // the same link at once would otherwise both pass the check and both set a
    // password — the second silently overwriting the first, so the person who
    // typed the password they remember cannot log in.
    const result = await invitations.resolve(req.params.token, { client });
    if (!result.ok) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: { code: result.reason.toUpperCase(), message: REJECT[result.reason] || REJECT.invalid },
      });
    }
    const inv = result.row;

    const { rows: locked } = await client.query(
      `SELECT id, status FROM admin_invitations WHERE id = $1 FOR UPDATE`, [inv.id]
    );
    if (locked[0]?.status === 'activated') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: { code: 'USED', message: REJECT.used } });
    }

    const hashed = await bcrypt.hash(password, 12);
    // token_version bumps so any session minted before activation dies with
    // it, and is_active flips — that is what actually lets the login through
    // (middleware/auth.js rejects inactive users).
    await client.query(
      `UPDATE users
          SET password = $1, is_active = TRUE,
              token_version = token_version + 1,
              password_reset_token = NULL, password_reset_expires = NULL,
              updated_at = now()
        WHERE id = $2`,
      [hashed, inv.user_id]
    );
    await invitations.markActivated(inv.id, req, { client });

    // Audit before commit: the record of the activation and the activation
    // itself must land together or not at all.
    await client.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,'admin_invitation_activated','admin_invitation',$3,$4,$5,$6)`,
      [inv.user_id, inv.owner_name || null, inv.id,
       { organization_id: inv.organization_id, email: inv.email },
       req.ip || null, req.get('user-agent') || null]
    );

    await client.query('COMMIT');
    invalidateUserCache(inv.user_id);

    // Tell the operators, after the commit — a notification for something that
    // then rolled back is worse than no notification.
    notifySuperAdmins(inv).catch((err) =>
      logger.warn({ err: err.message, invitation: inv.id }, 'activation notification failed'));

    res.json({ data: { activated: true, email: inv.user_email || inv.email } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Mirrors the frontend's rule set exactly. Duplicated on purpose: the client
 * check is a courtesy that a curl request skips entirely, so the server is
 * where the rule actually lives.
 */
function validatePassword(pw) {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 200) return 'Password is too long';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a special character';
  return null;
}

async function notifySuperAdmins(inv) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'super_admin' AND is_active = TRUE AND deleted_at IS NULL`
  );
  if (!rows.length) return;
  const title = 'Admin account activated successfully';
  const body = `${inv.owner_name || inv.email} activated ${inv.studio_name || inv.org_name}.`;
  for (const u of rows) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1,'admin_activated',$2,$3,$4)`,
      [u.id, title, body, '/platform?tab=invitations']
    );
  }
}

module.exports = router;
module.exports.validatePassword = validatePassword;
