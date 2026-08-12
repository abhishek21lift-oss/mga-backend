'use strict';
// Admin invitations — token issuing, lifecycle, and the rate limit.
//
// All the decisions live here; the routes are thin. That split matters for one
// reason above the others: the rules about what a token is worth (how long it
// lives, whether a used one can be replayed, whether an expired one is
// distinguishable from a forged one) must have exactly one implementation. Two
// call sites each doing their own check is how one of them ends up lenient.
//
// ── What is stored, and what is not ──────────────────────────────────────
//
// The raw token is returned to the caller once, goes into the email, and is
// never persisted. Only SHA-256(raw) is. Same convention as
// password_reset_token in routes/auth.js, so there is one way tokens work in
// this codebase rather than two.

const crypto = require('crypto');
const pool = require('../db/pool');

/** How long an invitation is good for. */
const EXPIRY_HOURS = parseInt(process.env.INVITE_EXPIRY_HOURS, 10) || 24;

/** Sends allowed per account per window, counting the first one. */
const RATE_LIMIT_MAX = parseInt(process.env.INVITE_RATE_LIMIT, 10) || 3;
const RATE_LIMIT_WINDOW_HOURS = 1;

/** Statuses from which an invitation can still be resent or cancelled. */
const OPEN_STATUSES = ['pending', 'sent', 'opened'];

/** A new random token and the hash to store for it. */
function issueToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * The status to SHOW for a row.
 *
 * `status` is a stored column, but expiry is a function of the clock — an
 * invitation that lapsed overnight is still 'sent' in the database until
 * something touches it. Deriving it on read means the list is never wrong
 * while waiting for a sweep, and there is no cron to forget to run.
 *
 * Terminal states are returned untouched: an invitation that was ACTIVATED
 * before its expiry does not become 'expired' afterwards, which would rewrite
 * history to say the studio never onboarded.
 */
function effectiveStatus(row) {
  if (!row) return null;
  if (row.status === 'activated' || row.status === 'cancelled') return row.status;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return row.status;
}

/** Row shape the API returns. Never includes token_hash. */
function present(row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    email: row.email,
    owner_name: row.owner_name,
    studio_name: row.studio_name,
    status: effectiveStatus(row),
    expires_at: row.expires_at,
    sent_at: row.sent_at,
    opened_at: row.opened_at,
    activated_at: row.activated_at,
    cancelled_at: row.cancelled_at,
    send_attempts: row.send_attempts,
    last_error: row.last_error,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

/**
 * Have too many invitations gone to this account recently?
 *
 * Counted from rows actually created, not from an in-memory counter: the API
 * runs on more than one instance, and a per-process counter would multiply the
 * real limit by the instance count. It also survives a restart, which is
 * exactly when someone retrying a broken send would otherwise get a fresh
 * allowance.
 */
async function withinRateLimit(userId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
       FROM admin_invitations
      WHERE user_id = $1
        AND created_at >= now() - ($2 || ' hours')::interval`,
    [userId, String(RATE_LIMIT_WINDOW_HOURS)]
  );
  const used = rows[0]?.n || 0;
  return { ok: used < RATE_LIMIT_MAX, used, max: RATE_LIMIT_MAX, windowHours: RATE_LIMIT_WINDOW_HOURS };
}

/**
 * Create an invitation and return its RAW token.
 *
 * Takes a `client` so the caller can run this inside the same transaction that
 * created the studio — a studio that exists with no invitation row, because
 * the insert failed after the commit, is an account nobody can ever claim.
 */
async function create({ client = pool, userId, organizationId, email, ownerName, studioName, req }) {
  const { raw, hash } = issueToken();
  const { rows } = await client.query(
    `INSERT INTO admin_invitations
       (user_id, organization_id, email, owner_name, studio_name, token_hash,
        status, expires_at, created_by, created_by_name, created_ip, created_user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,'pending', now() + ($7 || ' hours')::interval, $8,$9,$10,$11)
     RETURNING *`,
    [
      userId, organizationId, String(email).toLowerCase(), ownerName || null, studioName || null,
      hash, String(EXPIRY_HOURS),
      req?.user?.id || null, req?.user?.name || null,
      req?.ip || null, req?.get?.('user-agent') || null,
    ]
  );
  return { invitation: rows[0], token: raw };
}

/**
 * Supersede every open invitation for an account.
 *
 * Called before issuing a new one. Without it a resend leaves the previous
 * link working, so "resend because the first one may have been intercepted"
 * would leave the intercepted link live — the opposite of what the operator
 * intended.
 */
async function supersedeOpen(userId, { client = pool } = {}) {
  await client.query(
    `UPDATE admin_invitations
        SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE user_id = $1 AND status = ANY($2)`,
    [userId, OPEN_STATUSES]
  );
}

/**
 * Resolve a raw token to its invitation.
 *
 * Returns a reason rather than throwing, so the caller decides what to reveal.
 * Every rejection is the same shape on purpose: an attacker probing tokens
 * learns only "no", never "that one existed but expired", which would confirm
 * a valid guess.
 */
async function resolve(rawToken, { client = pool } = {}) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
    return { ok: false, reason: 'invalid' };
  }
  const { rows } = await client.query(
    `SELECT i.*, o.name AS org_name, o.slug AS org_slug, u.email AS user_email
       FROM admin_invitations i
       JOIN organizations o ON o.id = i.organization_id
       JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = $1`,
    [hashToken(rawToken)]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };

  const status = effectiveStatus(row);
  // A used token must never work twice — that is the whole point of a
  // single-use link, and it is what stops a forwarded email from letting a
  // second person re-set the password on a live studio.
  if (status === 'activated') return { ok: false, reason: 'used', row };
  if (status === 'cancelled') return { ok: false, reason: 'cancelled', row };
  if (status === 'expired') return { ok: false, reason: 'expired', row };
  return { ok: true, row };
}

async function markSent(id, { client = pool } = {}) {
  await client.query(
    `UPDATE admin_invitations
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
    `UPDATE admin_invitations
        SET send_attempts = send_attempts + 1,
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, String(message || '').slice(0, 500)]
  );
}

/**
 * Record that the email was opened.
 *
 * Only ever moves 'sent' → 'opened'. An open registered after activation must
 * not walk the status backwards, and mail clients do re-fetch images long
 * after the fact.
 */
async function markOpened(trackId, { client = pool } = {}) {
  await client.query(
    `UPDATE admin_invitations
        SET status = 'opened',
            opened_at = COALESCE(opened_at, now()),
            updated_at = now()
      WHERE track_id = $1 AND status IN ('pending','sent')`,
    [trackId]
  );
}

async function markActivated(id, req, { client = pool } = {}) {
  await client.query(
    `UPDATE admin_invitations
        SET status = 'activated', activated_at = now(),
            activated_ip = $2, activated_user_agent = $3, updated_at = now()
      WHERE id = $1`,
    [id, req?.ip || null, req?.get?.('user-agent') || null]
  );
}

async function cancel(id, { client = pool } = {}) {
  const { rows } = await client.query(
    `UPDATE admin_invitations
        SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE id = $1 AND status = ANY($2)
      RETURNING *`,
    [id, OPEN_STATUSES]
  );
  return rows[0] || null;
}

module.exports = {
  EXPIRY_HOURS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_HOURS, OPEN_STATUSES,
  issueToken, hashToken, effectiveStatus, present,
  withinRateLimit, create, supersedeOpen, resolve,
  markSent, markSendFailed, markOpened, markActivated, cancel,
};
