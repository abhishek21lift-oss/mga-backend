// src/lib/aiQuota.js
//
// Per-studio AI token allowances: what a studio has used this month, what it
// is allowed, and whether the next request should be refused.
//
// ── Resolution, most specific wins ───────────────────────────────────────────
//
//   1. an explicit row in organization_ai_limits  (NULL there = unlimited,
//      deliberately overriding the platform default)
//   2. ai_platform_settings.default_monthly_tokens
//   3. unlimited
//
// The distinction between "a row whose monthly_tokens is NULL" and "no row at
// all" carries meaning and must not be collapsed: the first is an operator
// saying *this studio is exempt*, the second is *nobody has decided*. Folding
// them together would silently re-apply the platform default to a studio that
// was deliberately exempted.
//
// ── Enforcement is off until switched on ─────────────────────────────────────
//
// `enforcement_enabled` gates refusal, not measurement. Usage is always
// computed and always reportable; only the guard's decision changes. That way
// an operator can set limits, watch who would have been cut off, and turn
// enforcement on once the numbers look right — rather than discovering the
// thresholds were wrong by cutting off a paying studio.
'use strict';

const logger = require('./logger');

/** Calendar month, because that is the unit an allowance is quoted in. */
const PERIOD_SQL = `date_trunc('month', now())`;

async function loadSettings(client) {
  const db = client || require('../db/pool');
  const { rows } = await db.query('SELECT * FROM ai_platform_settings WHERE id = TRUE');
  return rows[0] || { enforcement_enabled: false, default_monthly_tokens: null, warn_at_pct: 80 };
}

/**
 * Tokens this studio has spent in the current calendar month.
 *
 * ai_usage_log has no organization_id, so this joins through users. That means
 * usage follows the ACCOUNT: a trainer who moves studios takes their history
 * with them. Worth knowing when reading a sudden jump — it may be a transfer,
 * not a spike.
 */
async function usedThisMonth(orgId, client) {
  const db = client || require('../db/pool');
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.tokens_total), 0)::bigint AS tokens,
            count(*)::int AS requests
       FROM ai_usage_log l
       JOIN users u ON u.id = l.user_id
      WHERE u.organization_id = $1::uuid
        AND l.created_at >= ${PERIOD_SQL}`,
    [orgId]
  );
  return { tokens: Number(rows[0].tokens), requests: rows[0].requests };
}

/**
 * The studio's allowance, and where it came from.
 * @returns {Promise<{limit: number|null, source: 'studio'|'default'|'none'}>}
 */
async function limitFor(orgId, client) {
  const db = client || require('../db/pool');
  const { rows } = await db.query(
    'SELECT monthly_tokens FROM organization_ai_limits WHERE organization_id = $1::uuid', [orgId]
  );
  if (rows.length) {
    // A row exists: its value wins even when NULL, which means "exempt".
    return { limit: rows[0].monthly_tokens === null ? null : Number(rows[0].monthly_tokens), source: 'studio' };
  }
  const settings = await loadSettings(db);
  if (settings.default_monthly_tokens != null) {
    return { limit: Number(settings.default_monthly_tokens), source: 'default' };
  }
  return { limit: null, source: 'none' };
}

/**
 * Everything the UI and the guard both need, in one place so they can never
 * disagree about whether a studio is over.
 */
async function statusFor(orgId, client) {
  const db = client || require('../db/pool');
  const [settings, used, lim] = await Promise.all([
    loadSettings(db), usedThisMonth(orgId, db), limitFor(orgId, db),
  ]);
  const pct = lim.limit ? Math.round((used.tokens / lim.limit) * 1000) / 10 : null;
  return {
    tokens_used: used.tokens,
    requests: used.requests,
    limit: lim.limit,
    limit_source: lim.source,
    used_pct: pct,
    over: lim.limit !== null && used.tokens >= lim.limit,
    warn: lim.limit !== null && pct !== null && pct >= settings.warn_at_pct,
    enforcement_enabled: settings.enforcement_enabled,
  };
}

/**
 * Express guard for AI routes.
 *
 * Refuses only when enforcement is ON, a limit exists, and it is exceeded.
 * Every other path — enforcement off, no limit, under the limit, or the check
 * itself failing — calls next(). A quota check that errors must not take the
 * AI Suite down with it; failing open is the correct bias for a cost control.
 */
function requireAiQuota() {
  return async function aiQuotaGuard(req, res, next) {
    try {
      const orgId = req.user?.organization_id;
      if (!orgId || req.user.role === 'super_admin') return next();

      const s = await statusFor(orgId);
      if (!s.enforcement_enabled || !s.over) return next();

      return res.status(429).json({
        error: {
          code: 'AI_QUOTA_EXCEEDED',
          message: 'This studio has used its AI allowance for this month.',
          tokens_used: s.tokens_used,
          limit: s.limit,
        },
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'ai quota check failed — allowing the request');
      return next();
    }
  };
}

module.exports = { PERIOD_SQL, loadSettings, usedThisMonth, limitFor, statusFor, requireAiQuota };
