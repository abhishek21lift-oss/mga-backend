// src/routes/reports.js
const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

// Null-safe tenant param: a tenant user gets their org id (queries then filter
// `organization_id = $x`); a platform super admin operating platform-wide gets
// NULL, and `$x IS NULL OR organization_id = $x` matches every row. A super
// admin targeting one org via x-org-id gets that org id and is filtered.
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

// GET /api/reports/monthly
// ISSUE-029: UNIONs gym payments with PT payments so the monthly
// revenue figures include both revenue streams.
router.get('/monthly', auth, async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const isTrainer = req.user.role === 'trainer';
    const tid = isTrainer ? req.user.trainer_id : null;
    const params = tid ? [parseInt(year), tid] : [parseInt(year)];
    const trainerWhere = tid ? 'AND p.trainer_id=$2' : '';
    // Tenant isolation: scope PT revenue to the caller's org (null-safe for
    // platform super admins). The legacy `payments` union is empty here.
    params.push(orgParam(req));
    const ptOrgWhere = `AND ($${params.length}::uuid IS NULL OR p.organization_id = $${params.length})`;

    const { rows } = await pool.query(`
      SELECT
        month_num,
        month_name,
        COUNT(*) AS payment_count,
        COALESCE(SUM(revenue), 0) AS revenue,
        COALESCE(SUM(incentives), 0) AS incentives
      FROM (
        SELECT
          EXTRACT(MONTH FROM p.date::date) AS month_num,
          TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month') AS month_name,
          p.amount AS revenue,
          p.incentive_amt AS incentives
        FROM payments p
        WHERE EXTRACT(YEAR FROM p.date::date) = $1
          AND p.deleted_at IS NULL
          ${trainerWhere}
        UNION ALL
        SELECT
          EXTRACT(MONTH FROM p.date::date) AS month_num,
          TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month') AS month_name,
          p.amount AS revenue,
          p.incentive_amt AS incentives
        FROM pt_payments p
        WHERE EXTRACT(YEAR FROM p.date::date) = $1
          AND p.deleted_at IS NULL
          ${trainerWhere}
          ${ptOrgWhere}
      ) combined
      GROUP BY month_num, month_name
      ORDER BY month_num`, params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainer-summary (admin only)
// ISSUE-021: after migration 017/018, PT clients live in pt_clients and PT
// payments live in pt_payments. Both tables are joined so the summary
// includes gym clients + PT clients and gym payments + PT payments.
router.get('/trainer-summary', auth, adminOnly, async (req, res, next) => {
  try {
    // Tenant isolation: scope to the caller's org via the driving `trainers`
    // table (null-safe for platform super admins). The client/payment joins
    // hang off trainer_id, so scoping trainers scopes the whole summary.
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.status='active'   AND c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.date   >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients     c   ON c.trainer_id   = t.id
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN payments    p   ON p.trainer_id   = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
        AND ($1::uuid IS NULL OR t.organization_id = $1)
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`,
      [orgParam(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trainers — alias for /trainer-summary (used by frontend Reports page)
// ISSUE-021: mirrors the fix above — includes pt_clients + pt_payments.
router.get('/trainers', auth, adminOnly, async (req, res, next) => {
  try {
    // Tenant isolation: scope to the caller's org via the driving `trainers`
    // table (null-safe for platform super admins).
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.specialization,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.status='active'   AND c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL) AS active_clients,
        COUNT(DISTINCT c.id)   FILTER (WHERE c.deleted_at IS NULL)   +
        COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.deleted_at IS NULL) AS total_clients,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.date   >= DATE_TRUNC('month',NOW()) AND p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month',NOW()) AND ptp.deleted_at IS NULL), 0) AS month_revenue,
        COALESCE(SUM(p.amount)   FILTER (WHERE p.deleted_at IS NULL),   0) +
        COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0) AS total_revenue
      FROM trainers t
      LEFT JOIN clients     c   ON c.trainer_id   = t.id
      LEFT JOIN pt_clients  ptc ON ptc.trainer_id = t.id
      LEFT JOIN payments    p   ON p.trainer_id   = t.id
      LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
      WHERE t.status = 'active'
        AND ($1::uuid IS NULL OR t.organization_id = $1)
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`,
      [orgParam(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue — total collected revenue for a date range
// Unions gym payments + PT payments so the figure includes both streams.
// Called by api.reports.revenue() in the frontend.
router.get('/revenue', auth, async (req, res, next) => {
  try {
    const { from, to, year } = req.query;
    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    if (from) { conditions.push(`p.date >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`p.date <= $${p++}`); params.push(to); }
    if (year && !from && !to) {
      conditions.push(`EXTRACT(YEAR FROM p.date::date) = $${p++}`);
      params.push(parseInt(year));
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    // Tenant isolation: scope PT revenue to the caller's org inside the
    // pt_payments arm of the union (null-safe for platform super admins). The
    // legacy `payments` arm is empty in this deployment.
    params.push(orgParam(req));
    const orgIdx = params.length;

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                AS count,
        COALESCE(SUM(p.amount), 0)   AS total,
        COALESCE(SUM(p.incentive_amt), 0) AS total_incentives
      FROM (
        SELECT amount, incentive_amt, date, deleted_at FROM payments
        UNION ALL
        SELECT amount, incentive_amt, date, deleted_at FROM pt_payments
        WHERE ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})
      ) p
      ${where}
    `, params);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dues
router.get('/dues', auth, async (req, res, next) => {
  try {
    const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
    const params = [];
    let trainerFilter = '';
    if (tid) {
      params.push(tid);
      trainerFilter = ` AND trainer_id = $${params.length}`;
    }
    // Tenant isolation: scope PT dues to the caller's org inside the pt_clients
    // arm of the union (null-safe for platform super admins). The legacy
    // `clients` arm is empty in this deployment.
    params.push(orgParam(req));
    const orgIdx = params.length;
    const { rows } = await pool.query(`
      SELECT id, client_id, name, mobile, trainer_name, photo_url,
             balance_amount, pt_end_date, status
      FROM (
        SELECT c.id, c.client_id, c.name, c.mobile, c.trainer_name, c.photo_url,
               c.balance_amount, c.pt_end_date, c.status, c.trainer_id
        FROM clients c
        WHERE c.balance_amount > 0 AND c.deleted_at IS NULL
        UNION ALL
        SELECT ptc.id, NULL AS client_id, ptc.name, ptc.mobile, ptc.trainer_name, ptc.photo_url,
               ptc.balance_amount, ptc.pt_end_date, ptc.status, ptc.trainer_id
        FROM pt_clients ptc
        WHERE ptc.balance_amount > 0 AND ptc.deleted_at IS NULL
          AND ($${orgIdx}::uuid IS NULL OR ptc.organization_id = $${orgIdx})
      ) combined
      WHERE 1=1${trainerFilter}
      ORDER BY balance_amount DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── Monthly revenue target ──────────────────────────────────────────────────
//
// A studio admin commits to one revenue figure per calendar month. Once set it
// cannot be changed — that is enforced by a UNIQUE (organization_id, period)
// constraint and by the deliberate absence of any update route, NOT by
// disabling an input on the client.
//
// `achieved` reuses the EXACT union that GET /monthly aggregates (payments +
// pt_payments, same date column, same soft-delete filter, same org scope). If
// the two ever diverged, the hero card and the chart directly below it would
// show different numbers for the same month, which destroys trust in both.

/** Sum of this month's revenue for the caller's scope. */
async function currentMonthRevenue(req) {
  const params = [orgParam(req)];
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(revenue), 0) AS achieved
    FROM (
      SELECT p.amount AS revenue
        FROM payments p
       WHERE p.deleted_at IS NULL
         AND date_trunc('month', p.date::date) = date_trunc('month', CURRENT_DATE)
      UNION ALL
      SELECT p.amount AS revenue
        FROM pt_payments p
       WHERE p.deleted_at IS NULL
         AND date_trunc('month', p.date::date) = date_trunc('month', CURRENT_DATE)
         AND ($1::uuid IS NULL OR p.organization_id = $1)
    ) combined`, params);
  return Number(rows[0]?.achieved ?? 0);
}

// GET /api/reports/revenue-target — this month's target, progress and lock state.
router.get('/revenue-target', auth, async (req, res, next) => {
  try {
    const orgId = orgParam(req);
    const [{ rows }, achieved] = await Promise.all([
      pool.query(
        `SELECT t.id, t.period, t.target_amount, t.created_at, u.name AS set_by_name
           FROM revenue_targets t
           LEFT JOIN users u ON u.id = t.set_by
          WHERE t.period = date_trunc('month', CURRENT_DATE)::date
            AND ($1::uuid IS NULL OR t.organization_id = $1)
          LIMIT 1`,
        [orgId],
      ),
      currentMonthRevenue(req),
    ]);

    const row = rows[0] || null;
    const target = row ? Number(row.target_amount) : null;

    res.json({
      data: {
        period: row?.period ?? new Date().toISOString().slice(0, 7) + '-01',
        target_amount: target,
        achieved,
        // Never negative: once the target is beaten "remaining" is zero, not a
        // negative number the UI would have to special-case.
        balance: target !== null ? Math.max(0, target - achieved) : null,
        surplus: target !== null ? Math.max(0, achieved - target) : null,
        pct: target !== null && target > 0 ? Math.min(999, (achieved / target) * 100) : null,
        // The single flag the client renders from — it must not infer the lock
        // from the presence of a value and get it subtly wrong.
        locked: Boolean(row),
        set_by_name: row?.set_by_name ?? null,
        set_at: row?.created_at ?? null,
        // Only an admin may set it; surfaced so the UI shows the right message
        // to a trainer rather than a form that will 403.
        can_set: req.user.role === 'admin' || req.user.role === 'super_admin',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/revenue-target — set this month's target. Once only.
router.post('/revenue-target', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgParam(req);
    if (!orgId) {
      // A platform super admin with no x-org-id has no studio to set a target
      // for. Fail loudly rather than writing an orphan row.
      return res.status(400).json({ error: 'Select an organization first' });
    }

    const amount = Number(req.body?.target_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ error: 'Enter a target amount greater than zero' });
    }
    // Matches NUMERIC(12,2): anything larger would be a fat-finger, and letting
    // it through returns a confusing 500 from the column overflow instead.
    if (amount > 9999999999) {
      return res.status(422).json({ error: 'That target is unrealistically large' });
    }

    const { rows } = await pool.query(
      `INSERT INTO revenue_targets (organization_id, period, target_amount, set_by)
       VALUES ($1, date_trunc('month', CURRENT_DATE)::date, $2, $3)
       ON CONFLICT (organization_id, period) DO NOTHING
       RETURNING id, period, target_amount, created_at`,
      [orgId, amount.toFixed(2), req.user.id],
    );

    // DO NOTHING + no returned row means a target already existed for this
    // month. This is the lock firing, and it is race-safe: two concurrent
    // requests cannot both insert, because the unique index arbitrates.
    if (!rows[0]) {
      return res.status(409).json({
        error: 'This month’s target is already set and cannot be changed until next month',
        code: 'TARGET_ALREADY_SET',
      });
    }

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
