'use strict';
// The trainer's side of client logins: turn one on, resend the link, turn it
// off, and see where it stands.
//
// Mounted at /api/client-login behind auth + requireStaff (see server.js), so
// nothing here re-checks that the caller is staff. What every handler DOES
// re-check is that the client belongs to the caller's studio — the mount
// proves the caller is staff somewhere, not that they are staff HERE, and a
// client id is a value the caller chose.
//
// ── The rule this enforces ───────────────────────────────────────────────
//
// A login is what somebody gets for having paid. Activation is refused unless
// the client has paid something, has a real email, has no login already, and
// the studio's subscription is live. The refusal carries a reason, because the
// trainer's screen explains why the button is unavailable and a bare 403
// cannot.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const invites = require('../lib/clientInvitations');
const email = require('../lib/email');
const { tenantScope } = require('../lib/tenant-db');
const { frontendUrl } = require('../lib/frontendUrl');
const { invalidateUserCache } = require('../middleware/auth');

const router = express.Router();

/**
 * Load a client, scoped to the caller's studio.
 *
 * Returns null for "not in your studio" exactly as it does for "does not
 * exist", and the caller turns both into the same 404. A distinguishable
 * response here would let one studio probe another's client ids.
 */
async function loadClient(req, id, { client = pool } = {}) {
  const scope = tenantScope(req);
  const params = [id];
  let where = 'c.id = $1';
  if (scope.applyFilter) {
    params.push(scope.orgId);
    where += ' AND c.organization_id = $2';
  }
  const { rows } = await client.query(
    `SELECT c.id, c.name, c.email, c.photo_url, c.trainer_id, c.organization_id,
            c.paid_amount, c.balance_amount, c.deleted_at,
            c.user_id, c.login_activated, c.activation_sent_at,
            o.name AS studio_name,
            u.email AS login_email, u.is_active AS login_enabled,
            u.last_login_at, u.email_verified_at, u.locked_until
       FROM pt_clients c
       LEFT JOIN organizations o ON o.id = c.organization_id
       LEFT JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
      WHERE ${where}`,
    params
  );
  return rows[0] || null;
}

/** The most recent invitation for a client, with its status derived on read. */
async function latestInvitation(ptClientId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM client_invitations
      WHERE pt_client_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [ptClientId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: invites.effectiveStatus(row),
    expires_at: row.expires_at,
    sent_at: row.sent_at,
    activated_at: row.activated_at,
    send_attempts: row.send_attempts,
    last_error: row.last_error,
    invited_by_name: row.invited_by_name,
    created_at: row.created_at,
  };
}

/** Everything the trainer's card renders, in one shape. */
function presentStatus(c, invitation) {
  const check = invites.eligibility(c);
  return {
    client_id: c.id,
    login_activated: !!c.login_activated,
    login_enabled: c.login_activated ? !!c.login_enabled : false,
    login_email: c.login_email || null,
    email_verified_at: c.email_verified_at || null,
    last_login_at: c.last_login_at || null,
    locked_until: c.locked_until || null,
    activation_sent_at: c.activation_sent_at || null,
    // What the button should do, decided here rather than in the UI. Two
    // implementations of "may this client be activated" is how they diverge.
    can_activate: check.ok,
    blocked_reason: check.ok ? null : check.reason,
    blocked_message: check.ok ? null : check.message,
    invitation,
  };
}

/**
 * Issue a link and send it.
 *
 * The users row, the pt_clients flags and the invitation row are written in
 * one transaction: an account that exists with no invitation is one nobody can
 * ever claim, and an invitation with no account resolves to a token pointing
 * at nothing.
 *
 * The email is sent AFTER the commit, on purpose. Sending inside would mean a
 * client receiving a live link for a transaction that then rolled back. A send
 * that fails after the commit is recoverable — the trainer sees the error on
 * the card and presses Resend.
 */
async function issueAndSend(req, res, c, { reactivate = false } = {}) {
  const rate = await invites.withinRateLimit(c.id);
  if (!rate.ok) {
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `Only ${rate.max} activation emails per client per hour. Try again shortly.`,
      },
    });
  }

  const client = await pool.connect();
  let invitation, token, userId;
  try {
    await client.query('BEGIN');

    // Lock the client row. Two trainers pressing Activate at once would
    // otherwise both pass the eligibility check and create two accounts for
    // one person — the unique index would stop the second, but as a 500
    // rather than a clean answer.
    await client.query('SELECT id FROM pt_clients WHERE id = $1 FOR UPDATE', [c.id]);

    const { rows: fresh } = await client.query(
      'SELECT user_id, login_activated FROM pt_clients WHERE id = $1', [c.id]
    );
    if (!reactivate && fresh[0]?.login_activated) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'ALREADY_ACTIVE', message: 'This client already has a login.' },
      });
    }

    userId = fresh[0]?.user_id || null;

    if (userId) {
      // Re-issuing for an existing account. is_active goes FALSE until the new
      // link is used: a resend must not leave the old password working, or
      // "resend because the account may be compromised" achieves nothing.
      await client.query(
        `UPDATE users
            SET is_active = FALSE,
                token_version = token_version + 1,
                email = $2,
                updated_at = now()
          WHERE id = $1`,
        [userId, String(c.email).toLowerCase()]
      );
    } else {
      userId = `usr-${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO users
           (id, name, email, password, role, organization_id, trainer_id, pt_client_id,
            is_active, token_version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'member',$5,$6,$7, FALSE, 0, now(), now())`,
        [
          userId, c.name, String(c.email).toLowerCase(),
          // Not a password: 60 random hex characters that no bcrypt hash can
          // ever match, so the row cannot be logged into before activation
          // even if is_active were flipped by mistake. The real hash is
          // written when the client sets one.
          `!${crypto.randomBytes(30).toString('hex')}`,
          c.organization_id, c.trainer_id, c.id,
        ]
      );
    }

    await client.query(
      `UPDATE pt_clients
          SET user_id = $2, activation_sent_at = now(), updated_at = now()
        WHERE id = $1`,
      [c.id, userId]
    );

    await invites.supersedeOpen(c.id, { client });
    ({ invitation, token } = await invites.create({
      client,
      userId,
      ptClientId: c.id,
      organizationId: c.organization_id,
      email: c.email,
      clientName: c.name,
      studioName: c.studio_name,
      req,
    }));

    await client.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,'client_login_invited','pt_client',$3,$4,$5,$6)`,
      [req.user.id, req.user.name || null, c.id,
       { invitation_id: invitation.id, email: c.email, reactivate },
       req.ip || null, req.get('user-agent') || null]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  invalidateUserCache(userId);

  // frontendUrl(), not a hand-rolled env read. This originally used
  // `process.env.APP_URL || FRONTEND_URL || 'https://myptstudio.com'`, which
  // was wrong three ways: APP_URL is set nowhere — docker-compose passes only
  // FRONTEND_URL — so it always fell through to the hardcoded string; that
  // string being the right domain today is luck, and a staging deploy would
  // have mailed clients a link to production; and it did not normalise a
  // trailing slash, which is the exact defect frontendUrl was written for
  // after "https://example.com//reset-password" reached real users.
  const actionUrl = frontendUrl(`/client/activate?token=${token}`);
  let sent = false;
  let sendError = null;
  try {
    await email.sendClientActivation({
      to: c.email,
      clientName: c.name,
      studioName: c.studio_name,
      actionUrl,
      expiryHours: invites.EXPIRY_HOURS,
    });
    await invites.markSent(invitation.id);
    sent = true;
  } catch (err) {
    sendError = err.message;
    await invites.markSendFailed(invitation.id, err.message).catch(() => {});
    logger.error({ err: err.message, client: c.id }, 'client activation email failed');
  }

  const refreshed = await loadClient(req, c.id);
  res.status(sent ? 200 : 502).json({
    data: presentStatus(refreshed, await latestInvitation(c.id)),
    // The account exists and the link is live either way. Saying so matters:
    // without it a failed send reads as "activation failed", and the trainer
    // presses Activate again instead of Resend.
    email_sent: sent,
    ...(sent ? {} : {
      error: {
        code: 'EMAIL_FAILED',
        message: `The login was created but the email could not be sent (${sendError}). Use Resend once mail is working.`,
      },
    }),
  });
}

// ── GET /api/client-login/:clientId ──────────────────────────────────────────
router.get('/:clientId', async (req, res, next) => {
  try {
    const c = await loadClient(req, req.params.clientId);
    if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });
    res.json({ data: presentStatus(c, await latestInvitation(c.id)) });
  } catch (err) { next(err); }
});

// ── POST /api/client-login/:clientId/activate ────────────────────────────────
router.post('/:clientId/activate', async (req, res, next) => {
  try {
    const c = await loadClient(req, req.params.clientId);
    if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });

    const check = invites.eligibility(c);
    if (!check.ok) {
      return res.status(409).json({ error: { code: check.reason.toUpperCase(), message: check.message } });
    }
    await issueAndSend(req, res, c);
  } catch (err) { next(err); }
});

// ── POST /api/client-login/:clientId/resend ──────────────────────────────────
// Also the repair path for an account whose first email never arrived, so it
// tolerates login_activated being either true or false.
router.post('/:clientId/resend', async (req, res, next) => {
  try {
    const c = await loadClient(req, req.params.clientId);
    if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });
    if (!c.email) {
      return res.status(409).json({ error: { code: 'NO_EMAIL', message: 'Add a valid email address to this client first.' } });
    }
    if (!c.user_id && !invites.eligibility(c).ok) {
      const check = invites.eligibility(c);
      return res.status(409).json({ error: { code: check.reason.toUpperCase(), message: check.message } });
    }
    await issueAndSend(req, res, c, { reactivate: true });
  } catch (err) { next(err); }
});

// ── POST /api/client-login/:clientId/deactivate ──────────────────────────────
// Revokes access without deleting the account, so history and the audit trail
// survive and re-enabling is a Resend rather than a rebuild.
router.post('/:clientId/deactivate', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const c = await loadClient(req, req.params.clientId, { client });
    if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });
    if (!c.user_id) {
      return res.status(409).json({ error: { code: 'NOT_ACTIVE', message: 'This client has no login.' } });
    }

    await client.query('BEGIN');
    // token_version bumps so every session already issued dies now, rather
    // than at its own expiry. Deactivation that leaves a live session running
    // for another hour is not deactivation.
    await client.query(
      `UPDATE users
          SET is_active = FALSE, token_version = token_version + 1, updated_at = now()
        WHERE id = $1`,
      [c.user_id]
    );
    await client.query(
      `UPDATE pt_clients SET login_activated = FALSE, updated_at = now() WHERE id = $1`,
      [c.id]
    );
    await invites.supersedeOpen(c.id, { client });
    await client.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,'client_login_deactivated','pt_client',$3,$4,$5,$6)`,
      [req.user.id, req.user.name || null, c.id, { user_id: c.user_id },
       req.ip || null, req.get('user-agent') || null]
    );
    await client.query('COMMIT');
    invalidateUserCache(c.user_id);

    const refreshed = await loadClient(req, c.id);
    res.json({ data: presentStatus(refreshed, await latestInvitation(c.id)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.loadClient = loadClient;
module.exports.presentStatus = presentStatus;
