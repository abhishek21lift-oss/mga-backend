// src/modules/command-center/collectors/smtp.collector.js
//
// Mail health, on top of lib/email.js — no second transport, no second config
// parser. That file already knows what "configured" means, already verifies a
// connection, and already turns SMTP error codes into sentences an operator can
// act on (`diagnose()`); duplicating any of it would mean two definitions of
// "is mail working" that drift.
//
// ── Why the live probe is behind a flag ─────────────────────────────────────
//
// verifyConnection() opens a real TCP connection and runs an SMTP handshake.
// On a tick-driven console that is a connection every few seconds to a provider
// that rate-limits and, on a timeout, blocks for the full socket timeout. So
// the default probe is configuration + recent delivery outcomes, which is cheap
// and read from data we already have; the handshake runs only on an explicit
// fresh probe (the Test SMTP command in Phase 5).
//
// ── Why this card will be red today ─────────────────────────────────────────
//
// Worth knowing before reading its first output: no invitation email has ever
// been delivered on this platform. admin_invitations shows 2 rows, 0 with
// sent_at, one carrying "Connection timeout". The card is supposed to say so.
'use strict';

const { STATUS, result } = require('../registry');
const pool = require('../../../db/pool');
const email = require('../../../lib/email');

const NAME = 'smtp';

async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.probe=false] run a real SMTP handshake
 */
async function collect(opts = {}) {
  const configured = email.isConfigured();
  const config = email.describeConfig();

  // Delivery evidence, from the only durable record of outbound mail we keep.
  const invitations = await optional(async () => {
    const { rows } = await pool.query(`
      SELECT count(*)::int                                          AS total,
             count(*) FILTER (WHERE sent_at IS NOT NULL)::int        AS sent,
             count(*) FILTER (WHERE last_error IS NOT NULL)::int     AS errored,
             count(*) FILTER (WHERE send_attempts > 0
                                AND sent_at IS NULL)::int            AS attempted_never_sent,
             max(sent_at)                                            AS last_sent_at,
             (SELECT last_error FROM admin_invitations
               WHERE last_error IS NOT NULL
               ORDER BY updated_at DESC LIMIT 1)                     AS last_error
        FROM admin_invitations`);
    return rows[0];
  });

  let probe = null;
  if (opts.probe) {
    probe = await optional(() => email.verifyConnection(), { ok: false, reason: 'PROBE_FAILED' });
  }

  const data = {
    configured,
    // describeConfig names the missing variables; never echo SMTP_PASS.
    missing_vars: config?.missing ?? null,
    host: config?.host ?? null,
    port: config?.port ?? null,
    from: config?.from ?? null,
    delivery: invitations ? {
      invitations_total: invitations.total,
      invitations_sent: invitations.sent,
      invitations_errored: invitations.errored,
      attempted_never_sent: invitations.attempted_never_sent,
      last_sent_at: invitations.last_sent_at,
      last_error: invitations.last_error,
    } : null,
    live_probe: probe,
    probe_note: opts.probe ? null : 'Live SMTP handshake runs only on demand — it is a real connection per probe',
  };

  if (!configured) {
    // Not "unavailable": mail being off is an outage for invitations and
    // password resets, both of which the product depends on. The forgot-password
    // endpoint answers "a reset link has been sent" either way, so nothing else
    // in the system will ever tell you about this.
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: `SMTP not configured — missing ${(config?.missing || []).join(', ') || 'credentials'}. Invitations and password resets are silently discarded.`,
    });
  }

  if (probe && probe.ok === false) {
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: probe.diagnosis || probe.message || `SMTP handshake failed (${probe.reason})`,
    });
  }

  // Configured but nothing has ever gone out is the exact state this platform
  // is in, and it is invisible from every other screen.
  if (invitations && invitations.total > 0 && invitations.sent === 0) {
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: `${invitations.total} invitation(s) created, none delivered${invitations.last_error ? ` — last error: ${invitations.last_error}` : ''}`,
    });
  }

  if (invitations && invitations.attempted_never_sent > 0) {
    return result(NAME, {
      status: STATUS.WARNING,
      data,
      reason: `${invitations.attempted_never_sent} message(s) attempted but never sent`,
    });
  }

  return result(NAME, { status: STATUS.HEALTHY, data, reason: null });
}

module.exports = { NAME, collect };
