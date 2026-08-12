'use strict';
// The client's side of activation. Deliberately UNAUTHENTICATED — the person
// using it has no password yet, which is the entire point.
//
// The sibling of routes/invitations.js, which does this for studio owners, and
// held to the same constraints because it is the same kind of surface:
//
//   • The token is the only credential. Single-use, time-limited, matched by
//     hash — see lib/clientInvitations.js.
//   • Every rejection returns the same shape. Somebody probing tokens must not
//     be able to tell "expired" from "never existed", because the first
//     confirms a valid guess.
//   • Nothing here reveals an address that was not already supplied. The
//     preview returns the studio, the client's first name and a masked email,
//     so the recipient can confirm they are activating the right account
//     without the endpoint becoming an email-disclosure oracle.

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const invites = require('../lib/clientInvitations');
const { invalidateUserCache } = require('../middleware/auth');
const { validatePassword } = require('./invitations');

const router = express.Router();

// Public and token-guessing-adjacent, so it gets its own limiter rather than
// riding the general API one. Generous enough that a person re-reading their
// email and clicking twice is never blocked.
const activationLimiter = rateLimit({
  store: makeStore('activation'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

/** One shape for every rejection, so nothing is learned from the difference. */
const REJECT = {
  invalid: 'This activation link is not valid.',
  expired: 'This activation link has expired. Ask your trainer to send a new one.',
  used: 'This link has already been used. Try signing in instead.',
  cancelled: 'This link was cancelled. Ask your trainer to send a new one.',
};

/** a***@example.com — enough to recognise, not enough to harvest. */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}

/** First name only. The full name is not needed to confirm "this is me". */
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// ── GET /api/client-activation/:token ────────────────────────────────────────
// What the create-password page loads first: is this link good, and whose?
router.get('/:token', activationLimiter, async (req, res, next) => {
  try {
    const result = await invites.resolve(req.params.token);
    if (!result.ok) {
      return res.status(410).json({
        error: { code: result.reason.toUpperCase(), message: REJECT[result.reason] || REJECT.invalid },
      });
    }
    const r = result.row;
    res.json({
      data: {
        studio_name: r.studio_name || r.org_name,
        client_name: firstName(r.pt_client_name || r.client_name),
        email_masked: maskEmail(r.user_email || r.email),
        expires_at: r.expires_at,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/client-activation/:token/accept ────────────────────────────────
// Set the password and switch the account on.
router.post('/:token/accept', activationLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const password = String(req.body?.password || '');
    // The server's copy of the rule, shared with the admin flow so the two
    // cannot drift. The client-side check is a courtesy that curl skips.
    const problem = validatePassword(password);
    if (problem) return res.status(400).json({ error: { code: 'VALIDATION', message: problem } });

    await client.query('BEGIN');

    // Re-resolve INSIDE the transaction and lock the row. Two tabs submitting
    // the same link at once would otherwise both pass the check and both set a
    // password — the second silently overwriting the first, so the person who
    // typed the password they remember cannot log in.
    const result = await invites.resolve(req.params.token, { client });
    if (!result.ok) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: { code: result.reason.toUpperCase(), message: REJECT[result.reason] || REJECT.invalid },
      });
    }
    const inv = result.row;

    const { rows: locked } = await client.query(
      `SELECT id, status FROM client_invitations WHERE id = $1 FOR UPDATE`, [inv.id]
    );
    if (locked[0]?.status === 'activated') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: { code: 'USED', message: REJECT.used } });
    }

    // Cost 12, matching every other password write in this codebase. bcrypt
    // rather than argon2 for the same reason: one hashing scheme, or a login
    // has to try both and the weaker one is the one that decides.
    const hashed = await bcrypt.hash(password, 12);
    // is_active flips — that is what actually lets the login through, since
    // middleware/auth.js and the login query both reject inactive users. The
    // token_version bump kills anything minted before activation. Clearing the
    // lockout counters matters because a client who forgot they had a link and
    // guessed at a password several times would otherwise activate straight
    // into a locked account.
    await client.query(
      `UPDATE users
          SET password = $1,
              is_active = TRUE,
              token_version = token_version + 1,
              email_verified_at = now(),
              password_changed_at = now(),
              failed_login_attempts = 0,
              locked_until = NULL,
              password_reset_token = NULL,
              password_reset_expires = NULL,
              updated_at = now()
        WHERE id = $2`,
      [hashed, inv.user_id]
    );

    // Clicking the link proves the address works, which is the only evidence
    // of email ownership this flow ever gets.
    await client.query(
      `UPDATE pt_clients
          SET login_activated = TRUE, user_id = $2, updated_at = now()
        WHERE id = $1`,
      [inv.pt_client_id, inv.user_id]
    );

    await invites.markActivated(inv.id, req, { client });

    // Audit before commit: the record of the activation and the activation
    // itself must land together or not at all.
    await client.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,'client_login_activated','pt_client',$3,$4,$5,$6)`,
      [inv.user_id, inv.pt_client_name || null, inv.pt_client_id,
       { invitation_id: inv.id, organization_id: inv.organization_id },
       req.ip || null, req.get('user-agent') || null]
    );

    await client.query('COMMIT');
    invalidateUserCache(inv.user_id);

    notifyTrainer(inv).catch((err) =>
      logger.warn({ err: err.message, invitation: inv.id }, 'client activation notification failed'));

    res.json({ data: { activated: true, email: inv.user_email || inv.email } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Tell the trainer their client is in.
 *
 * After the commit, and never allowed to fail the request: a notification for
 * something that then rolled back is worse than no notification, and a
 * notification insert that throws must not undo a completed activation.
 */
async function notifyTrainer(inv) {
  if (!inv.invited_by) return;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES ($1,'client_activated',$2,$3,$4)`,
    [
      inv.invited_by,
      'Client login activated',
      `${inv.pt_client_name || inv.client_name || 'A client'} has set their password and can now sign in.`,
      `/clients/${inv.pt_client_id}`,
    ]
  );
}

module.exports = router;
