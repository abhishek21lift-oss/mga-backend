// src/modules/command-center/collectors/security.collector.js
//
// Security posture: authentication pressure plus configuration that is either
// right or wrong with no middle ground.
//
// The login numbers come from `login_events`, the same table
// super-admin/security.js reads. This card does not restate that screen — it
// answers a narrower question: is something happening RIGHT NOW that an
// operator should interrupt their evening for. Hence 1-hour windows alongside
// the 24-hour ones, and a distinct-IP count, because 40 failures from one
// address is a person who forgot their password and 40 from forty addresses is
// a credential-stuffing run.
//
// The posture checks are deliberately boolean and boring. Every one of them has
// exactly one correct value, so drift is detectable without a threshold: a
// short JWT secret, a permissive CORS origin, a missing FRONTEND_URL. These are
// the settings that are fine for a year and then are not, and nothing else in
// the product ever looks at them again after boot.
'use strict';

const { STATUS, result } = require('../registry');
const pool = require('../../../db/pool');

const NAME = 'security';

const FAILED_1H_WARN = Number(process.env.CC_FAILED_LOGIN_WARN) || 10;
const FAILED_1H_CRIT = Number(process.env.CC_FAILED_LOGIN_CRIT) || 40;
// A secret shorter than this is brute-forceable; the app requires 32 at boot.
const MIN_JWT_SECRET_LEN = 32;

async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/** Configuration that is simply right or wrong — no thresholds involved. */
function posture() {
  const isProd = process.env.NODE_ENV === 'production';
  const jwt = process.env.JWT_SECRET || '';
  const corsRaw = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '';

  const checks = [
    {
      key: 'jwt_secret_length',
      ok: jwt.length >= MIN_JWT_SECRET_LEN,
      detail: `${jwt.length} chars (minimum ${MIN_JWT_SECRET_LEN})`,
    },
    {
      key: 'frontend_url_set',
      ok: Boolean(process.env.FRONTEND_URL),
      detail: process.env.FRONTEND_URL ? 'set' : 'missing — CORS and email links break',
    },
    {
      key: 'cors_not_wildcard',
      ok: corsRaw !== '*' && !corsRaw.includes('*'),
      detail: corsRaw.includes('*') ? 'wildcard origin allowed' : 'explicit origins',
    },
    {
      key: 'cors_https_in_production',
      ok: !isProd || corsRaw.split(',').every((o) => !o.trim() || o.trim().startsWith('https://')),
      detail: 'all allowed origins must be https in production',
    },
    {
      key: 'webauthn_rp_configured',
      // Not cosmetic: without these, passkey registration fails at verify with
      // an origin mismatch and nothing server-side records why.
      ok: Boolean(process.env.RP_ID && process.env.WEBAUTHN_ORIGIN),
      detail: process.env.RP_ID ? 'RP_ID and WEBAUTHN_ORIGIN set' : 'RP_ID / WEBAUTHN_ORIGIN missing — passkeys cannot complete',
    },
    {
      key: 'sentry_configured',
      ok: Boolean(process.env.SENTRY_DSN),
      detail: process.env.SENTRY_DSN ? 'errors reported' : 'no error reporting',
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  return {
    checks,
    failed_count: failed.length,
    // Plain proportion. A weighted "security score" invites arguing about the
    // weights instead of fixing the failing check.
    score: Math.round(((checks.length - failed.length) / checks.length) * 100),
  };
}

async function collect() {
  const [auth, sessions] = await Promise.all([
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*) FILTER (WHERE outcome <> 'success'
                                  AND created_at > now() - interval '1 hour')::int  AS failed_1h,
               count(*) FILTER (WHERE outcome = 'success'
                                  AND created_at > now() - interval '1 hour')::int  AS success_1h,
               count(DISTINCT ip_address) FILTER (WHERE outcome <> 'success'
                                  AND created_at > now() - interval '1 hour')::int  AS failing_ips_1h,
               count(DISTINCT email_attempted) FILTER (WHERE outcome <> 'success'
                                  AND created_at > now() - interval '1 hour')::int  AS targeted_accounts_1h,
               count(*) FILTER (WHERE outcome <> 'success'
                                  AND created_at > now() - interval '24 hours')::int AS failed_24h,
               count(*) FILTER (WHERE outcome = 'success'
                                  AND created_at > now() - interval '24 hours')::int AS success_24h
          FROM login_events`);
      return rows[0];
    }),
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS active
          FROM refresh_tokens
         WHERE revoked_at IS NULL AND expires_at > now()`);
      return rows[0].active;
    }),
  ]);

  const p = posture();
  const failed1h = auth?.failed_1h ?? 0;
  const ips1h = auth?.failing_ips_1h ?? 0;

  const data = {
    auth: auth ? { ...auth, active_sessions: sessions } : null,
    posture: p,
    // Distinguishes one locked-out user from a distributed attempt.
    spread: failed1h > 0 ? Math.round((failed1h / Math.max(ips1h, 1)) * 10) / 10 : null,
  };

  let status = STATUS.HEALTHY;
  let reason = null;

  // A broken security setting outranks traffic noise: it is certain, whereas
  // failed logins are usually somebody's caps lock.
  const criticalPosture = p.checks.filter(
    (c) => !c.ok && ['jwt_secret_length', 'cors_not_wildcard', 'cors_https_in_production'].includes(c.key));

  if (criticalPosture.length) {
    status = STATUS.CRITICAL;
    reason = criticalPosture.map((c) => `${c.key}: ${c.detail}`).join('; ');
  } else if (failed1h >= FAILED_1H_CRIT && ips1h > 3) {
    status = STATUS.CRITICAL;
    reason = `${failed1h} failed logins from ${ips1h} addresses in the last hour — distributed`;
  } else if (failed1h >= FAILED_1H_CRIT) {
    status = STATUS.WARNING;
    reason = `${failed1h} failed logins in the last hour from ${ips1h} address(es)`;
  } else if (failed1h >= FAILED_1H_WARN) {
    status = STATUS.WARNING;
    reason = `${failed1h} failed logins in the last hour`;
  } else if (p.failed_count) {
    status = STATUS.WARNING;
    reason = p.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail}`).join('; ');
  }

  return result(NAME, { status, data, reason });
}

module.exports = { NAME, collect, posture, FAILED_1H_WARN, FAILED_1H_CRIT, MIN_JWT_SECRET_LEN };
