// src/routes/trainers.js
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { trainerSchemas } = require('../lib/validation');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// Fields a non-admin (trainer) is allowed to see about other trainers.
// Salary, incentive_rate, address, dob, certifications etc. are scrubbed.
function scrubForNonAdmin(t) {
  if (!t) return t;
  const {
    salary, incentive_rate, address, dob, gender, mobile, email,
    certifications, notes,
    ...safe
  } = t;
  return safe;
}

// GET /api/trainers
router.get('/', auth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const isManager = req.user.role === 'manager';
    const ownTid = req.user.trainer_id || null;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Tenant isolation: a tenant admin/trainer only ever sees their own
    // organization's trainers; a super admin sees all (or one org via x-org-id).
    const scope = tenantScope(req);
    const where = ['t.deleted_at IS NULL'];
    const params = [];
    if (scope.applyFilter) { params.push(scope.orgId); where.push(`t.organization_id = $${params.length}`); }
    params.push(limit);  const limitIdx  = params.length;
    params.push(offset); const offsetIdx = params.length;

    const { rows } = await pool.query(`
      SELECT t.*,
        COUNT(c.id) FILTER (WHERE c.status='active')  AS active_clients,
        COUNT(c.id)                                    AS total_clients,
        COALESCE(SUM(p.amount) FILTER (WHERE p.date >= DATE_TRUNC('month',NOW())),0) AS month_revenue,
        COALESCE(SUM(p.amount),0) AS all_time_revenue
      FROM trainers t
      LEFT JOIN clients  c ON c.trainer_id = t.id
      LEFT JOIN payments p ON p.trainer_id = t.id
      WHERE ${where.join(' AND ')}
      GROUP BY t.id
      ORDER BY t.name
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params);

    const enriched = rows.map(t => ({
      ...t,
      active_clients:  parseInt(t.active_clients),
      total_clients:   parseInt(t.total_clients),
      month_revenue:   parseFloat(t.month_revenue),
      all_time_revenue:parseFloat(t.all_time_revenue),
      month_incentive: Math.round(parseFloat(t.month_revenue) * parseFloat(t.incentive_rate ?? 0.5) * 100) / 100
    }));

    // Admin/manager see everything. Other roles get the safe view EXCEPT
    // their own row — trainers must see their own salary/contact info.
    if (isAdmin || isManager) {
      res.json(enriched);
    } else {
      res.json(enriched.map((t) => (t.id === ownTid ? t : scrubForNonAdmin(t))));
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/trainers/:id  — full profile incl. clients + recent payments + KPIs
router.get('/:id', auth, async (req, res, next) => {
  try {
    // Tenant isolation: cross-org lookups 404 rather than leak the profile.
    const scope = tenantScope(req);
    const idParams = [req.params.id];
    let orgClause = '';
    if (scope.applyFilter) { idParams.push(scope.orgId); orgClause = ` AND organization_id = $${idParams.length}`; }
    const { rows } = await pool.query(`SELECT * FROM trainers WHERE id=$1 AND deleted_at IS NULL${orgClause}`, idParams);
    if (!rows[0]) return res.status(404).json({ error: 'Trainer not found' });

    const isAdmin = req.user.role === 'admin';
    const trainer = (!isAdmin && req.user.trainer_id !== rows[0].id)
      ? scrubForNonAdmin(rows[0])
      : rows[0];

    // Aggregated stats for this trainer
    const { rows: stats } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM clients WHERE trainer_id=$1)::int                                  AS total_clients,
        (SELECT COUNT(*) FROM clients WHERE trainer_id=$1 AND status='active')::int              AS active_clients,
        (SELECT COUNT(*) FROM clients WHERE trainer_id=$1 AND status='expired')::int             AS expired_clients,
        (SELECT COALESCE(SUM(balance_amount),0) FROM clients WHERE trainer_id=$1)::float          AS total_dues,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE trainer_id=$1)::float                 AS lifetime_revenue,
        (SELECT COALESCE(SUM(amount),0) FROM payments
          WHERE trainer_id=$1 AND date >= DATE_TRUNC('month', NOW()))::float                       AS month_revenue,
        (SELECT COALESCE(SUM(incentive_amt),0) FROM payments
          WHERE trainer_id=$1 AND date >= DATE_TRUNC('month', NOW()))::float                       AS month_incentive
    `, [req.params.id]);

    // Their clients
    const { rows: clients } = await pool.query(`
      SELECT id, client_id, name, mobile, package_type, pt_end_date,
             status, balance_amount, paid_amount, final_amount
      FROM clients WHERE trainer_id=$1
      ORDER BY created_at DESC LIMIT 100
    `, [req.params.id]);

    // Recent payments collected by this trainer
    const { rows: payments } = await pool.query(`
      SELECT id, client_name, amount, method, date, receipt_no, incentive_amt
      FROM payments WHERE trainer_id=$1
      ORDER BY date DESC, created_at DESC LIMIT 30
    `, [req.params.id]);

    // 6-month revenue trend
    const { rows: monthly } = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', date::date), 'Mon YY') AS month,
             COALESCE(SUM(amount),0)::float AS revenue
      FROM payments
      WHERE trainer_id=$1 AND date >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', date::date)
      ORDER BY DATE_TRUNC('month', date::date)
    `, [req.params.id]);

    // Hide salary-related stats from non-admin viewers
    if (!isAdmin && req.user.trainer_id !== rows[0].id) {
      delete stats[0].lifetime_revenue;
      delete stats[0].month_incentive;
    }

    res.json({ ...trainer, stats: stats[0], clients, payments, monthly });
  } catch (err) {
    next(err);
  }
});

// POST /api/trainers (admin only)
router.post('/', auth, adminOnly, validate(trainerSchemas.create), async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = randomUUID();
    const rate = (parseFloat(d.incentive_rate) || 50) / 100; // convert % to decimal
    const metadata = (d.metadata && typeof d.metadata === 'object') ? d.metadata : {};

    await pool.query(`
      INSERT INTO trainers (id,name,mobile,email,dob,gender,address,role,
        joining_date,salary,incentive_rate,specialization,certifications,
        status,notes,bio,schedule,biometric_code,biometric_added,metadata,organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [id, d.name.trim(), d.mobile||null, d.email?.toLowerCase()||null,
       d.dob||null, d.gender||null, d.address||null,
       d.role||'Personal Trainer', d.joining_date||null,
       parseFloat(d.salary)||0, rate,
       d.specialization||null, d.certifications||null,
       d.status||'active', d.notes||null,
       d.bio||null, d.schedule||null,
       d.biometric_code || `STF-${Date.now()}`, true,
       JSON.stringify(metadata), orgIdOf(req)]
    );
    const { rows } = await pool.query('SELECT * FROM trainers WHERE id=$1', [id]);
    res.status(201).json({ message: 'Trainer created', trainer: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/trainers/:id (admin only)
router.put('/:id', auth, adminOnly, validate(trainerSchemas.update), async (req, res, next) => {
  try {
    const d = req.body;
    const rate = d.incentive_rate !== undefined ? (parseFloat(d.incentive_rate)/100) : undefined;

    // Tenant isolation: only update a trainer inside the caller's org.
    const scope = tenantScope(req);
    const exParams = [req.params.id];
    let exOrgClause = '';
    if (scope.applyFilter) { exParams.push(scope.orgId); exOrgClause = ` AND organization_id = $${exParams.length}`; }
    const { rows: ex } = await pool.query(`SELECT * FROM trainers WHERE id=$1${exOrgClause}`, exParams);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });

    // Merge metadata — avoids wiping unrelated keys on partial updates
    const existingMeta = (ex[0].metadata && typeof ex[0].metadata === 'object') ? ex[0].metadata : {};
    const incomingMeta = (d.metadata && typeof d.metadata === 'object') ? d.metadata : {};
    const mergedMeta = { ...existingMeta, ...incomingMeta };

    await pool.query(`
      UPDATE trainers SET
        name=$1,mobile=$2,email=$3,dob=$4,gender=$5,address=$6,role=$7,
        joining_date=$8,salary=$9,incentive_rate=$10,specialization=$11,
        certifications=$12,status=$13,notes=$14,bio=$15,schedule=$16,
        biometric_code=$17,biometric_added=$18,metadata=$19,updated_at=NOW()
      WHERE id=$20`,
      [d.name?.trim()||ex[0].name, d.mobile||null, d.email?.toLowerCase()||null,
       d.dob||null, d.gender||null, d.address||null,
       d.role||ex[0].role, d.joining_date||null,
       parseFloat(d.salary)||0, rate??ex[0].incentive_rate,
       d.specialization||null, d.certifications||null,
       d.status||ex[0].status, d.notes||null,
       d.bio||null, d.schedule||null,
       d.biometric_code || ex[0].biometric_code || `STF-${req.params.id.slice(0, 8)}`,
       Boolean(d.biometric_code || ex[0].biometric_code),
       JSON.stringify(mergedMeta),
       req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM trainers WHERE id=$1', [req.params.id]);
    res.json({ message: 'Updated', trainer: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/trainers/:id (admin only) — soft-delete to preserve payment/client history
router.delete('/:id', auth, adminOnly, async (req, res, next) => {
  try {
    // Tenant isolation: only delete a trainer inside the caller's org.
    const scope = tenantScope(req);
    const delParams = [req.params.id];
    let delOrgClause = '';
    if (scope.applyFilter) { delParams.push(scope.orgId); delOrgClause = ` AND organization_id = $${delParams.length}`; }
    const { rows } = await pool.query(
      `UPDATE trainers SET deleted_at = NOW(), status = 'inactive', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL${delOrgClause} RETURNING id`,
      delParams
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/trainers/sessions — create a PT session
router.post('/sessions', auth, async (req, res, next) => {
  try {
    const { trainer_id, client_id, date, time, duration, type, notes } = req.body;
    if (!trainer_id || !client_id || !date) {
      return res.status(400).json({ error: 'trainer_id, client_id, and date are required' });
    }
    const startTime = time || null;
    const endTime = (time && duration)
      ? (() => {
          const [h, m] = time.split(':').map(Number);
          const end = new Date(0, 0, 0, h, m + Math.round(duration));
          return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
        })()
      : null;

    const { rows } = await pool.query(
      `INSERT INTO pt_sessions (client_id, trainer_id, title, session_date, start_time, end_time, notes, created_by, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [client_id, trainer_id, type || 'PT Session', date, startTime, endTime, notes || null, req.user.id, orgIdOf(req)]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Sessions table not ready. Run migrations.' });
    next(err);
  }
});

// GET /api/trainers/:id/sessions — upcoming/past sessions for a trainer
router.get('/:id/sessions', auth, async (req, res, next) => {
  try {
    // Tenant isolation: scope the trainer's sessions to the caller's org.
    const scope = tenantScope(req);
    const sessParams = [req.params.id];
    let orgClause = '';
    if (scope.applyFilter) { sessParams.push(scope.orgId); orgClause = ` AND s.organization_id = $${sessParams.length}`; }
    const { rows } = await pool.query(
      `WITH all_clients AS (
         SELECT id, name, mobile FROM clients WHERE deleted_at IS NULL
         UNION ALL
         SELECT id, name, mobile FROM pt_clients WHERE deleted_at IS NULL
       )
       SELECT s.*, ac.name AS client_name, ac.mobile AS client_mobile
       FROM pt_sessions s
       LEFT JOIN all_clients ac ON ac.id = s.client_id
       WHERE s.trainer_id = $1${orgClause}
       ORDER BY s.session_date DESC, s.session_time DESC
       LIMIT 50`,
      sessParams
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

module.exports = router;
