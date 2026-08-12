'use strict';
// Platform analytics — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  pool,
} = require('./shared');
// How many months of history the trend and cohort grid cover.
function analyticsWindow(req) {
  const n = parseInt(req.query.months, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 12, 3), 24);
}

// A studio counts as "engaged" if it did real work: booked a session,
// onboarded a client, or marked attendance. Those are the three things a
// studio cannot fake by leaving a tab open, which is exactly why last_login is
// not one of them — and why the same three define both the trend and the
// at-risk list, so an operator never sees a studio called active in one panel
// and dormant in another.
const ENGAGED_ORGS_30D = `
  SELECT organization_id FROM pt_sessions
   WHERE deleted_at IS NULL AND organization_id IS NOT NULL
     AND created_at >= now() - interval '30 days'
  UNION
  SELECT organization_id FROM pt_clients
   WHERE deleted_at IS NULL AND organization_id IS NOT NULL
     AND created_at >= now() - interval '30 days'
  UNION
  SELECT organization_id FROM attendance_logs
   WHERE organization_id IS NOT NULL
     AND created_at >= now() - interval '30 days'`;

// ── GET /analytics ────────────────────────────────────────────────────────
router.get('/analytics', async (req, res, next) => {
  try {
    const months = analyticsWindow(req);

    const [trend, adoption, cohorts, atRisk, leaderboard, denomRow] = await Promise.all([
      // Monthly engagement. generate_series is the spine so a month in which
      // nothing happened renders as a zero rather than vanishing — a gap in a
      // line chart reads as "no data", which is a different claim.
      pool.query(`
        WITH months AS (
          SELECT generate_series(
                   date_trunc('month', now()) - ($1 || ' months')::interval,
                   date_trunc('month', now()),
                   interval '1 month')::date AS month
        )
        SELECT to_char(m.month, 'Mon YY') AS label,
               m.month,
               (SELECT count(DISTINCT s.organization_id) FROM pt_sessions s
                 WHERE s.deleted_at IS NULL
                   AND s.created_at >= m.month
                   AND s.created_at < m.month + interval '1 month')::int AS active_studios,
               (SELECT count(*) FROM pt_sessions s
                 WHERE s.deleted_at IS NULL
                   AND s.created_at >= m.month
                   AND s.created_at < m.month + interval '1 month')::int AS sessions,
               (SELECT count(*) FROM pt_clients c
                 WHERE c.deleted_at IS NULL
                   AND c.created_at >= m.month
                   AND c.created_at < m.month + interval '1 month')::int AS clients_added,
               (SELECT count(*) FROM attendance_logs a
                 WHERE a.created_at >= m.month
                   AND a.created_at < m.month + interval '1 month')::int AS check_ins,
               (SELECT count(*) FROM organizations o
                 WHERE o.created_at >= m.month
                   AND o.created_at < m.month + interval '1 month')::int AS studios_joined
          FROM months m
         ORDER BY m.month`,
        [months - 1]
      ),

      // Feature adoption: how many studios touched each capability in 30 days.
      // The keys match the platform feature registry so an operator reading
      // "AI Suite: 1 of 12 studios" can act on it in the Features tab without
      // translating between two vocabularies.
      pool.query(`
        SELECT 'sessions' AS key,
               count(DISTINCT organization_id)::int AS studios
          FROM pt_sessions WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'
        UNION ALL
        SELECT 'clients', count(DISTINCT organization_id)::int
          FROM pt_clients WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'
        UNION ALL
        SELECT 'attendance', count(DISTINCT organization_id)::int
          FROM attendance_logs WHERE created_at >= now() - interval '30 days'
        UNION ALL
        SELECT 'ai_suite', count(DISTINCT u.organization_id)::int
          FROM ai_usage_log l JOIN users u ON u.id = l.user_id
         WHERE l.created_at >= now() - interval '30 days' AND u.organization_id IS NOT NULL`
      ),

      // Retention by signup cohort. Row = the month a studio joined, column =
      // months since. A studio counts as retained in month N if it did real
      // work in that month, so this measures the product holding on to people,
      // not a subscription row that nobody cancelled.
      pool.query(`
        WITH cohort AS (
          SELECT id, date_trunc('month', created_at)::date AS joined
            FROM organizations
           WHERE created_at >= date_trunc('month', now()) - ($1 || ' months')::interval
        ), sizes AS (
          -- The cohort's size has to be counted BEFORE the join to work, and
          -- carried in. Counting it alongside the retained count in one GROUP BY
          -- counts only the studios in each group, so a 4-studio cohort where
          -- 2 were active reports a size of 2 and a retention of 100%.
          SELECT joined, count(*)::int AS cohort_size FROM cohort GROUP BY joined
        ), work AS (
          SELECT organization_id AS id, date_trunc('month', created_at)::date AS month
            FROM pt_sessions WHERE deleted_at IS NULL AND organization_id IS NOT NULL
          UNION
          SELECT organization_id, date_trunc('month', created_at)::date
            FROM pt_clients WHERE deleted_at IS NULL AND organization_id IS NOT NULL
          UNION
          SELECT organization_id, date_trunc('month', created_at)::date
            FROM attendance_logs WHERE organization_id IS NOT NULL
        )
        SELECT to_char(c.joined, 'Mon YY') AS label,
               c.joined,
               s.cohort_size,
               w.month,
               (EXTRACT(YEAR FROM age(w.month, c.joined)) * 12
                + EXTRACT(MONTH FROM age(w.month, c.joined)))::int AS month_offset,
               count(DISTINCT w.id)::int AS retained
          FROM cohort c
          JOIN sizes s ON s.joined = c.joined
          LEFT JOIN work w ON w.id = c.id AND w.month >= c.joined
         GROUP BY c.joined, s.cohort_size, w.month
         ORDER BY c.joined, w.month`,
        [months - 1]
      ),

      // The actionable list: studios paying for a product they have stopped
      // opening. Trials are excluded — a quiet trial is a sales problem, a
      // quiet paying studio is a refund waiting to happen.
      pool.query(`
        SELECT o.id, o.name, o.slug, o.plan_code, o.subscription_status,
               o.current_period_end,
               (SELECT max(u.last_login) FROM users u
                 WHERE u.organization_id = o.id AND u.deleted_at IS NULL) AS last_login,
               (SELECT max(s.created_at) FROM pt_sessions s
                 WHERE s.organization_id = o.id AND s.deleted_at IS NULL)  AS last_session,
               (SELECT count(*) FROM pt_clients c
                 WHERE c.organization_id = o.id AND c.deleted_at IS NULL
                   AND c.status = 'active')::int                            AS active_clients
          FROM organizations o
         WHERE o.status <> 'suspended'
           AND o.subscription_status = 'active'
           AND o.id NOT IN (${ENGAGED_ORGS_30D})
         ORDER BY o.name`
      ),

      // Who is getting the most out of it. The counterweight to at-risk: the
      // same query shape, opposite end.
      pool.query(`
        -- logo_url is deliberately not selected. Studios may store their logo
        -- as a base64 data URI (one live studio's is ~25KB), so ten rows would
        -- carry a quarter of a megabyte of images into a ranking table that
        -- shows a name and three numbers.
        SELECT o.id, o.name, o.slug,
               (SELECT count(*) FROM pt_sessions s
                 WHERE s.organization_id = o.id AND s.deleted_at IS NULL
                   AND s.created_at >= now() - interval '30 days')::int AS sessions_30d,
               (SELECT count(*) FROM pt_clients c
                 WHERE c.organization_id = o.id AND c.deleted_at IS NULL
                   AND c.status = 'active')::int                        AS active_clients,
               (SELECT count(*) FROM attendance_logs a
                 WHERE a.organization_id = o.id
                   AND a.created_at >= now() - interval '30 days')::int AS check_ins_30d
          FROM organizations o
         WHERE o.status <> 'suspended'
         ORDER BY sessions_30d DESC, check_ins_30d DESC, active_clients DESC
         LIMIT 10`
      ),

      // Total studios in play, so every "N studios use X" has a denominator.
      // Without it adoption is a bare count and says nothing.
      pool.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status <> 'suspended')::int AS live
          FROM organizations`
      ),
    ]);

    // Pivot the cohort rows into a grid the client can render directly. Doing
    // it here rather than in the browser keeps the shape a contract rather
    // than an accident of one component.
    const grid = new Map();
    for (const r of cohorts.rows) {
      if (!grid.has(r.label)) {
        grid.set(r.label, { label: r.label, joined: r.joined, size: r.cohort_size, retention: {} });
      }
      if (r.month_offset !== null && r.retained > 0) {
        grid.get(r.label).retention[r.month_offset] = r.retained;
      }
    }

    const denom = denomRow.rows[0] || { total: 0, live: 0 };

    res.json({
      data: {
        months,
        studios: denom,
        trend: trend.rows,
        adoption: adoption.rows.map((r) => ({
          ...r,
          pct: denom.live > 0 ? Math.round((r.studios / denom.live) * 1000) / 10 : 0,
        })),
        cohorts: [...grid.values()],
        at_risk: atRisk.rows,
        leaderboard: leaderboard.rows,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  AI CONTROL CENTRE
//
//  Who is using the AI Suite, how hard, on which models, at what cost — and
//  what each studio is allowed.
//
//  ── Cost is only ever shown where it is known ──────────────────────────────
//
//  Rates are operator-entered (ai_model_rates, seeded empty). A model with no
//  configured rate contributes tokens but NO cost, and every response reports
//  `unpriced_models` so the UI can say the total is partial instead of
//  presenting an understated figure as complete. Nothing here guesses a price.
//
//  ── ai_usage_log has no organization_id ────────────────────────────────────
//
//  Every per-studio figure joins through users, so usage follows the ACCOUNT.
//  A trainer moving studios takes their history along. That is a property of
//  the existing table, not a choice made here, and it is surfaced in the API
//  docs rather than quietly producing surprising numbers.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
