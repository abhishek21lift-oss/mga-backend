// src/modules/command-center/tickets.js
//
// Short-lived, single-use tickets that authenticate the Command Center
// WebSocket.
//
// ── Why the socket cannot just use the session cookie ────────────────────────
//
// The session cookie is issued for `myptstudio.com`. The socket has to address
// `api.myptstudio.com` directly, because the frontend container's Next.js
// rewrite — which carries every ordinary /api/* call — is an HTTP proxy and
// does not forward an `Upgrade`. Those are different hosts, so the browser
// sends no cookie on the handshake. There is no header to fall back on either:
// `new WebSocket()` gives JavaScript no way to set `Authorization`.
//
// Three ways out, and why this is the one:
//
//   1. Widen the cookie to `.myptstudio.com`. Rejected. That sends the session
//      to every present and future subdomain, forever, to make one operator
//      console live-update. The blast radius is the whole product; the benefit
//      is one screen.
//   2. Smuggle the JWT through `Sec-WebSocket-Protocol`, which is the one
//      header a browser will set. Rejected: the server must echo the chosen
//      subprotocol back in the response, so the credential ends up in a
//      response header too, and in every proxy log along the way.
//   3. Mint a ticket over the already-authenticated HTTPS channel and spend it
//      in the handshake query string. This.
//
// ── Why single-use and 30 seconds ────────────────────────────────────────────
//
// A query string is the least private place to put a credential: nginx writes
// the full request line to its access log, and so does anything else in the
// path. Single-use plus a 30s window means a ticket recovered from a log is
// already spent and already expired — it authenticates one socket, once, and
// only within half a minute of being asked for.
//
// It is deliberately NOT a JWT. A signed token cannot be un-issued, so a
// stateless ticket is valid for its whole lifetime no matter how many sockets
// present it. Keeping the state is what makes "once" enforceable.
//
// ── Why in-process memory is the right store ─────────────────────────────────
//
// One API container serves this deployment, and the ticket is redeemed by the
// same process that issued it, seconds later. Redis would add a dependency to
// the login path of the console you open *because* Redis might be down. If
// this is ever load-balanced across processes, the redemption fails closed —
// the operator sees a reconnect, not a security hole — and that is when to
// move the store, not before.
'use strict';

const crypto = require('crypto');

/** How long a ticket stays redeemable. Long enough for one page load. */
const TTL_MS = Number(process.env.COMMAND_CENTER_TICKET_TTL_MS) || 30_000;

/**
 * A ceiling on outstanding tickets.
 *
 * Every ticket costs a small object until it is spent or expires, and the
 * issuing route is reachable by an authenticated super admin — so this is not
 * defence against an attacker, it is defence against a reconnect loop that
 * mints a ticket every second for a week.
 */
const MAX_OUTSTANDING = 100;

/** ticket -> { userId, email, issuedAt, expiresAt } */
const outstanding = new Map();

function sweep(now = Date.now()) {
  for (const [key, rec] of outstanding) {
    if (rec.expiresAt <= now) outstanding.delete(key);
  }
}

/**
 * Mint a ticket for an operator who has already passed the full
 * auth -> requireSuperAdmin -> requireSuperAdminMfa chain.
 *
 * @param {{ id: string|number, email?: string }} user
 * @returns {{ ticket: string, expires_in_ms: number }}
 */
function issue(user) {
  const now = Date.now();
  sweep(now);

  // Map preserves insertion order, so the first key is the oldest. Evicting it
  // is correct rather than merely convenient: the oldest unspent ticket is the
  // one closest to expiring anyway.
  while (outstanding.size >= MAX_OUTSTANDING) {
    outstanding.delete(outstanding.keys().next().value);
  }

  // 256 bits. base64url so it survives a query string with no escaping.
  const ticket = crypto.randomBytes(32).toString('base64url');
  outstanding.set(ticket, {
    userId: user.id,
    email: user.email,
    issuedAt: now,
    expiresAt: now + TTL_MS,
  });

  return { ticket, expires_in_ms: TTL_MS };
}

/**
 * Spend a ticket.
 *
 * Deleted on the way out whether or not it had expired, so a presented ticket
 * is never presentable twice — a replay of an expired ticket must not leave a
 * live one behind it in the map.
 *
 * @returns {{ userId: string|number, email?: string } | null} null when the
 *   ticket is unknown, already spent, or past its window.
 */
function redeem(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;
  const rec = outstanding.get(ticket);
  if (!rec) return null;
  outstanding.delete(ticket);
  if (rec.expiresAt <= Date.now()) return null;
  return { userId: rec.userId, email: rec.email };
}

/** Test/diagnostic only. */
function _size() { sweep(); return outstanding.size; }
function _clear() { outstanding.clear(); }

module.exports = { issue, redeem, TTL_MS, MAX_OUTSTANDING, _size, _clear };
