'use strict';
// Client login invitations — token issuing, lifecycle, and the rate limit.
//
// The sibling of lib/invitations.js, which does the same job for studio
// owners. The token rules are identical on purpose: single-use, hashed at
// rest, time-limited, and indistinguishable in failure. Two different answers
// to "how long is a link good for" in one codebase is how one of them ends up
// being the lenient one.
//
// What differs is who is allowed to issue one, and that is the whole reason
// this is a separate module rather than a `kind` column on the admin table:
//
//   • An admin invitation is issued by the platform operator and belongs to no
//     studio. A client invitation is issued by a trainer and belongs to
//     exactly one, so every read here is organization-scoped.
//   • An admin invitation is unconditional. A client invitation may only be
//     issued for somebody who has actually paid — see eligibility() below.
//
// The raw token is returned once, goes into the email, and is never persisted.
// Only SHA-256(raw) is stored.

const crypto = require('crypto');
const pool = require('../db/pool');

/** How long an activation link is good for. */
const EXPIRY_HOURS = parseInt(process.env.CLIENT_INVITE_EXPIRY_HOURS, 10) || 48;

/** Sends allowed per client per window, counting the first one. */
const RATE_LIMIT_MAX = parseInt(process.env.CLIENT_INVITE_RATE_LIMIT, 10) || 3;
const RATE_LIMIT_WINDOW_HOURS = 1;

/** Statuses an invitation can still be resent or cancelled from. */
const OPEN_STATUSES = ['pending', 'sent'];

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function issueToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

/**
 * The status to SHOW for a row.
 *
 * `status` is stored, but expiry is a function of the clock — a link that
 * lapsed overnight is still 'sent' in the database until something touches it.
 * Deriving on read means the trainer's screen is never wrong while waiting for
 * a sweep, and there is no cron to forget to run.
 *
 * Terminal states are returned untouched: an invitation activated before its
 * expiry does not become 'expired' afterwards, which would rewrite history to
 * say the client never onboarded.
 */
function effectiveStatus(row) {
  if (!row) return null;
  if (row.status === 'activated' || row.status === 'cancelled') return row.status;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return row.status;
}

/**
 * May this client be given a login?
 *
 * All four conditions, evaluated together and returned as a reason rather than
 * a boolean, because the trainer's screen explains why the button is not
 * available and a bare false cannot.
 *
 * The payment condition is the product rule the whole feature exists for: a
 * login is what somebody gets for having paid. `paid_amount > 0` rather than
 * `balance_amount <= 0` — a client part-way through an instalment plan has
 * paid and should have access; requiring a zero balance would lock out every
 * client on instalments, which is most of them.
 */
function eligibility(client) {
  if (!client) return { ok: false, reason: 'not_found', message: 'Client not found.' };
  if (client.deleted_at) return { ok: false, reason: 'deleted', message: 'This client has been deleted.' };
  if (client.login_activated) {
    return { ok: false, reason: 'already_active', message: 'This client already has a login.' };
  }
  if (!client.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(client.email))) {
    return { ok: false, reason: 'no_email', message: 'Add a valid email address to this client first.' };
  }
  if (!(Number(client.paid_amount) > 0)) {
    return { ok: false, reason: 'unpaid', message: 'A login can be created once the client has made a payment.' };
  }
  return { ok: true };
}

/**
 * Have too many links gone to this client recently?
 *
 * Counted from rows actually created, for the same reasons the lockout counter
 * lives in the users row: more than one API instance, and restarts.
 */
async function withinRateLimit(ptClientId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
       FROM client_invitations
      WHERE pt_client_id = $1
        AND created_at >= now() - ($2 || ' hours')::interval`,
    [ptClientId, String(RATE_LIMIT_WINDOW_HOURS)]
  );
  const used = rows[0]?.n || 0;
  return { ok: used < RATE_LIMIT_MAX, used, max: RATE_LIMIT_MAX, windowHours: RATE_LIMIT_WINDOW_HOURS };
}

/**
 * Supersede every open invitation for a client.
 *
 * Called before issuing a new one. Without it a resend leaves the previous
 * link live, so "resend because the first may have been intercepted" would
 * leave the intercepted link working — the opposite of the intent.
 */
async function supersedeOpen(ptClientId, { client = pool } = {}) {
  await client.query(
    `UPDATE client_invitations
        SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE pt_client_id = $1 AND status = ANY($2)`,
    [ptClientId, OPEN_STATUSES]
  );
}

/** Create an invitation and return its RAW token. */
async function create({
  client = pool, userId, ptClientId, organizationId, email,
  clientName, studioName, req,
}) {
  const { raw, hash } = issueToken();
  const { rows } = await client.query(
    `INSERT INTO client_invitations
       (user_id, pt_client_id, organization_id, email, client_name, studio_name,
        token_hash, status, expires_at, invited_by, invited_by_name,
        created_ip, created_user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', now() + ($8 || ' hours')::interval, $9,$10,$11,$12)
     RETURNING *`,
    [
      userId, ptClientId, organizationId || null, String(email).toLowerCase(),
      clientName || null, studioName || null, hash, String(EXPIRY_HOURS),
      req?.user?.id || null, req?.user?.name || null,
      req?.ip || null, req?.get?.('user-agent') || null,
    ]
  );
  return { invitation: rows[0], token: raw };
}

/**
 * Resolve a raw token to its invitation.
 *
 * Returns a reason rather than throwing, so the caller decides what to reveal.
 * Every rejection is the same shape on purpose: someone probing tokens learns
 * only "no", never "that one existed but expired", which would confirm a valid
 * guess.
 *
 * Deliberately NOT organization-scoped — the caller is an unauthenticated
 * person holding a link, so there is no org to scope to. The token itself is
 * the credential, which is why it is 32 random bytes and single-use.
 */
async function resolve(rawToken, { client = pool } = {}) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
    return { ok: false, reason: 'invalid' };
  }
  const { rows } = await client.query(
    `SELECT i.*, u.email AS user_email, c.name AS pt_client_name,
            c.photo_url AS pt_client_photo, o.name AS org_name
       FROM client_invitations i
       JOIN users u ON u.id = i.user_id
       JOIN pt_clients c ON c.id = i.pt_client_id
       LEFT JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = $1`,
    [hashToken(rawToken)]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };

  const status = effectiveStatus(row);
  // A used token must never work twice. That is what stops a forwarded email
  // from letting a second person set the password on a live account.
  if (status === 'activated') return { ok: false, reason: 'used', row };
  if (status === 'cancelled') return { ok: false, reason: 'cancelled', row };
  if (status === 'expired') return { ok: false, reason: 'expired', row };
  return { ok: true, row };
}

async function markSent(id, { client = pool } = {}) {
  await client.query(
    `UPDATE client_invitations
        SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END,
            sent_at = COALESCE(sent_at, now()),
            send_attempts = send_attempts + 1,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id]
  );
}

async function markSendFailed(id, message, { client = pool } = {}) {
  await client.query(
    `UPDATE client_invitations
        SET send_attempts = send_attempts + 1,
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, String(message || '').slice(0, 500)]
  );
}

async function markActivated(id, req, { client = pool } = {}) {
  await client.query(
    `UPDATE client_invitations
        SET status = 'activated', activated_at = now(),
            activated_ip = $2, activated_user_agent = $3, updated_at = now()
      WHERE id = $1`,
    [id, req?.ip || null, req?.get?.('user-agent') || null]
  );
}

module.exports = {
  EXPIRY_HOURS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_HOURS, OPEN_STATUSES,
  issueToken, hashToken, effectiveStatus, eligibility,
  withinRateLimit, create, supersedeOpen, resolve,
  markSent, markSendFailed, markActivated,
};
