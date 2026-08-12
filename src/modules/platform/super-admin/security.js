'use strict';
// Login events, threats and sessions — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  pool,
} = require('./shared');
const SECURITY_PAGE_MAX = 200;
// A window long enough to catch a slow, distributed attempt but short enough
// that yesterday's noise does not mask today's.
const THREAT_WINDOW_HOURS = 24;
const THREAT_MIN_FAILURES = 5;

function buildLoginFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (query.outcome) add('e.outcome = $?', query.outcome);
  if (query.method) add('e.method = $?', query.method);
  if (query.org_id) add('e.organization_id = $?::uuid', query.org_id);
  if (query.user_id) add('e.user_id = $?', query.user_id);
  if (query.ip) add('e.ip_address = $?', query.ip);
  // "Only the failures" is the single most common thing an operator wants, and
  // spelling out five outcome values in the query string is not it.
  if (query.failed === 'true') where.push(`e.outcome <> 'success'`);
  if (query.from) add('e.created_at >= $?::timestamptz', query.from);
  if (query.to) add("e.created_at < ($?::date + INTERVAL '1 day')", query.to);
  if (query.q) {
    params.push(`%${query.q}%`);
    const i = `$${params.length}`;
    where.push(`(e.email_attempted ILIKE ${i} OR e.ip_address ILIKE ${i} OR o.name ILIKE ${i})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ── GET /security/overview ───────────────────────────────────────────────────
// Measured at request time, never stored: a cached security posture is a
// security posture that can be wrong at exactly the wrong moment.
router.get('/security/overview', async (req, res, next) => {
  try {
    const [logins, mfa, sessions, impersonations] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE outcome = 'success')::int          AS success_24h,
                count(*) FILTER (WHERE outcome <> 'success')::int         AS failed_24h,
                count(DISTINCT ip_address) FILTER (WHERE outcome <> 'success')::int AS failing_ips_24h,
                count(DISTINCT email_attempted) FILTER (WHERE outcome <> 'success')::int AS targeted_accounts_24h,
                -- The loudest signal in the table: the password was right and
                -- only the second factor stopped them.
                count(*) FILTER (WHERE outcome = 'mfa_failed')::int       AS mfa_failed_24h
           FROM login_events
          WHERE created_at > now() - INTERVAL '24 hours'`
      ),
      // The platform's own exposure. A super_admin without a second factor can
      // reach every studio's data, so this is the number that matters most.
      pool.query(
        `SELECT u.id, u.name, u.email, u.last_login,
                COALESCE(p.mfa_enabled, FALSE) AS mfa_enabled
           FROM users u
           LEFT JOIN user_profiles p ON p.user_id = u.id
          WHERE u.role = 'super_admin' AND u.is_active = TRUE AND u.deleted_at IS NULL
          ORDER BY COALESCE(p.mfa_enabled, FALSE), u.name`
      ),
      pool.query(
        `SELECT count(*)::int AS active
           FROM refresh_tokens
          WHERE revoked_at IS NULL AND expires_at > now()`
      ),
      pool.query(
        `SELECT count(*)::int AS impersonations_7d
           FROM activity_log
          WHERE action = 'user_impersonated' AND created_at > now() - INTERVAL '7 days'`
      ),
    ]);

    const operators = mfa.rows;
    res.json({
      data: {
        checked_at: new Date().toISOString(),
        logins_24h: logins.rows[0],
        operators: {
          total: operators.length,
          without_mfa: operators.filter((o) => !o.mfa_enabled).length,
          accounts: operators,
        },
        active_sessions: sessions.rows[0].active,
        impersonations_7d: impersonations.rows[0].impersonations_7d,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /security/login-events ───────────────────────────────────────────────
router.get('/security/login-events', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, SECURITY_PAGE_MAX);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { clause, params } = buildLoginFilter(req.query);

    const SELECT = `
      SELECT e.id, e.user_id, e.email_attempted, e.organization_id, e.outcome,
             e.method, e.ip_address, e.user_agent, e.created_at,
             u.name AS user_name, u.role AS user_role, o.name AS organization_name
        FROM login_events e
        LEFT JOIN users u         ON u.id = e.user_id
        LEFT JOIN organizations o ON o.id = e.organization_id`;

    const [list, total] = await Promise.all([
      pool.query(
        `${SELECT} ${clause} ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM login_events e
           LEFT JOIN organizations o ON o.id = e.organization_id
           ${clause}`,
        params
      ),
    ]);

    res.json({
      data: list.rows,
      paging: { limit, offset, total: total.rows[0].n },
    });
  } catch (err) { next(err); }
});

// ── GET /security/threats ────────────────────────────────────────────────────
// Repeated failures grouped two ways, because they are two different attacks:
// many failures against ONE account is someone guessing a specific password;
// many failures from ONE address across MANY accounts is credential stuffing.
// A single combined list would hide whichever is currently smaller.
router.get('/security/threats', async (req, res, next) => {
  try {
    // Parsed then clamped, rather than `Number(x) || default`: that idiom
    // treats an explicit 0 as absent and silently widens the window to the
    // default instead of narrowing it to the minimum, which is the opposite
    // of what someone typing 0 was asking for.
    const num = (v, dflt) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : dflt);
    const hours = Math.min(Math.max(num(req.query.hours, THREAT_WINDOW_HOURS), 1), 720);
    const min = Math.max(num(req.query.min, THREAT_MIN_FAILURES), 2);

    const [byAccount, byIp] = await Promise.all([
      pool.query(
        `SELECT e.email_attempted, count(*)::int AS failures,
                count(DISTINCT e.ip_address)::int AS distinct_ips,
                max(e.created_at) AS last_attempt,
                -- Whether the run ENDED in a success is the difference between
                -- a repelled attack and a breach to investigate right now.
                EXISTS (
                  SELECT 1 FROM login_events s
                   WHERE s.email_attempted = e.email_attempted
                     AND s.outcome = 'success'
                     AND s.created_at > now() - ($1 || ' hours')::interval
                     AND s.created_at > max(e.created_at)
                ) AS succeeded_after
           FROM login_events e
          WHERE e.outcome <> 'success'
            AND e.created_at > now() - ($1 || ' hours')::interval
            AND e.email_attempted IS NOT NULL
          GROUP BY e.email_attempted
         HAVING count(*) >= $2
          ORDER BY count(*) DESC
          LIMIT 50`,
        [String(hours), min]
      ),
      pool.query(
        `SELECT e.ip_address, count(*)::int AS failures,
                count(DISTINCT e.email_attempted)::int AS accounts_targeted,
                max(e.created_at) AS last_attempt
           FROM login_events e
          WHERE e.outcome <> 'success'
            AND e.created_at > now() - ($1 || ' hours')::interval
            AND e.ip_address IS NOT NULL
          GROUP BY e.ip_address
         HAVING count(*) >= $2
          ORDER BY count(DISTINCT e.email_attempted) DESC, count(*) DESC
          LIMIT 50`,
        [String(hours), min]
      ),
    ]);

    res.json({
      data: {
        window_hours: hours,
        min_failures: min,
        by_account: byAccount.rows,
        by_ip: byIp.rows,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /security/sessions ───────────────────────────────────────────────────
// Live refresh tokens, which are what actually keeps someone signed in. An
// operator who wants to end them uses force-logout in Admin Management — it
// bumps token_version, which revokes every session at once.
router.get('/security/sessions', async (req, res, next) => {
  try {
    const params = [];
    let clause = `WHERE r.revoked_at IS NULL AND r.expires_at > now()`;
    if (req.query.org_id) { params.push(req.query.org_id); clause += ` AND u.organization_id = $${params.length}::uuid`; }

    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.email, u.role, u.last_login,
              o.id AS organization_id, o.name AS organization_name,
              count(*)::int AS sessions,
              min(r.created_at) AS oldest_session,
              max(r.created_at) AS newest_session
         FROM refresh_tokens r
         JOIN users u ON u.id::text = r.user_id::text
         LEFT JOIN organizations o ON o.id = u.organization_id
         ${clause}
        GROUP BY u.id, u.name, u.email, u.role, u.last_login, o.id, o.name
        ORDER BY count(*) DESC, max(r.created_at) DESC
        LIMIT 200`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PLATFORM ANALYTICS — is the product being USED?
//
//  Deliberately NOT a second billing dashboard. /subscription-metrics already
//  answers MRR, ARPU, plan mix, trial conversion and cash collected; repeating
//  any of that here would give an operator two numbers for one question and no
//  way to tell which is authoritative. This answers the question money cannot:
//  are studios actually working inside the product, and which ones stopped.
//
//  Every figure is derived from product events that have existed since the
//  beginning (sessions booked, clients added, attendance marked). Login history
//  is deliberately NOT the activity signal even though login_events exists: it
//  only starts at migration 125, so a 12-month trend built on it would show a
//  cliff that is an artefact of when we started recording, not of anything a
//  studio did. Fabricating that shape would be worse than not drawing it.
//
//  Read-only. Nothing here mutates, so nothing here is audited.
// ═══════════════════════════════════════════════════════════════════════════


module.exports = router;
