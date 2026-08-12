// src/routes/attendance.js
// Uses the canonical attendance_logs table (v4 schema).
// Column mapping from old attendance table:
//   attendance.type       → attendance_logs.ref_type
//   attendance.check_in   → attendance_logs.check_in_time (TIMESTAMPTZ)
//   attendance.check_out  → attendance_logs.check_out_time (TIMESTAMPTZ)
//   attendance.check_in_method → attendance_logs.method
//   trainer_id/name       → marked_by (references users.id)
// Removed: updated_at, branch_id, member_id, booking_id, pt_session_id, device_id
// Unique constraint: (ref_id, ref_type, date)

const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { requireStaff } = require('../middleware/rbac');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// ── AUD-004 (P1): this is the studio's back office ──────────────────────────
//
// Every route below was gated on `auth` alone. The mount in server.js adds
// `gate('attendance')`, which is [auth, requireFeature('attendance')] — a
// feature flag, not a role check. And the ownership check inside PUT and
// DELETE is written `if (req.user.role === 'trainer')`, so an account with role
// `member` falls straight through it.
//
// The result, with an ordinary session and no exploit: an activated client
// could read the studio's entire attendance register — every other client's
// name, dates and times — and create, edit or delete rows in it. Reproduced in
// __tests__/security/attendance.authz.test.js, where a `member` got 201 from
// POST /bulk and 200 from /stats, /gaps and /today-summary against the code
// this comment replaces.
//
// Declared HERE rather than at the mount, matching offers.js / campaigns.js /
// feedback.js / integrations.js: the guard travels with the router, so it
// cannot be lost if the mount is edited or the router is mounted a second time.
// `auth` runs twice as a result (once from the mount's gate, once here) and
// that is deliberate and cheap — the second call is a user-cache hit, and the
// same doubling already happens on every /api/pt-os mount.
//
// A client's own attendance is served by GET /api/me/attendance
// (modules/client-portal/client-portal.routes.js), which scopes to
// req.user.pt_client_id — so nothing member-facing is lost here.
router.use(auth, requireStaff);

// GET /api/attendance?date=YYYY-MM-DD&type=client&page=1&limit=100
router.get('/', auth, async (req, res, next) => {
  try {
    const { date, from, to, type = 'client', ref_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`a.ref_type = 'client'`);
      params.push(req.user.trainer_id);
      conditions.push(`a.ref_id IN (SELECT id FROM clients WHERE trainer_id = $${p} UNION SELECT id FROM pt_clients WHERE trainer_id = $${p})`);
      p++;
    }
    if (date)   { conditions.push(`a.date = $${p++}`);     params.push(date); }
    if (from)   { conditions.push(`a.date >= $${p++}`);    params.push(from); }
    if (to)     { conditions.push(`a.date <= $${p++}`);    params.push(to); }
    if (type)   { conditions.push(`a.ref_type = $${p++}`); params.push(type); }
    if (ref_id) { conditions.push(`a.ref_id = $${p++}`);   params.push(ref_id); }

    const scope = tenantScope(req);
    if (scope.applyFilter) { conditions.push(`a.organization_id = $${p++}`); params.push(scope.orgId); }

    const { sql: bsql, params: bparams } = req.branchScope.appendTo(params);
    if (bsql !== 'TRUE') conditions.push(`a.${bsql}`);
    p = bparams.length + 1;

    const whereClause = conditions.join(' AND ');

    // Pagination: if page is provided use paginated response, otherwise fall back to legacy limit
    if (req.query.page !== undefined) {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const offset = (page - 1) * limit;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS total FROM attendance_logs a WHERE ${whereClause}`,
        bparams
      );
      const total = parseInt(countRows[0].total);

      const { rows } = await pool.query(
        `SELECT a.id, a.ref_id, a.ref_type AS type, a.ref_name,
                a.date, a.check_in_time AS check_in, a.check_out_time AS check_out,
                a.status, a.notes, a.method AS check_in_method, a.created_at
           FROM attendance_logs a
         WHERE ${whereClause}
         ORDER BY a.date DESC, a.check_in_time DESC NULLS LAST
         LIMIT $${p} OFFSET $${p + 1}`,
        bparams.concat(limit, offset)
      );
      return res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
    }

    // Legacy: no page param — use default limit (200 for no date range, 500 cap for date range)
    const limit = (from || to) ? Math.min(5000, 500) : 200;

    const { rows } = await pool.query(
      `SELECT a.id, a.ref_id, a.ref_type AS type, a.ref_name,
              a.date, a.check_in_time AS check_in, a.check_out_time AS check_out,
              a.status, a.notes, a.method AS check_in_method, a.created_at
         FROM attendance_logs a
       WHERE ${whereClause}
       ORDER BY a.date DESC, a.check_in_time DESC NULLS LAST
       LIMIT $${p}`,
      bparams.concat(limit)
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance — mark attendance
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.ref_id || !d.date)
      return res.status(400).json({ error: 'ref_id and date required' });

    const type = d.type || 'client';

    // RBAC: trainers can only mark attendance for their own clients (gym and PT)
    if (req.user.role === 'trainer') {
      if (type === 'client') {
        const { rows: own } = await pool.query(
          `SELECT trainer_id FROM clients WHERE id = $1 AND deleted_at IS NULL
           UNION
           SELECT trainer_id FROM pt_clients WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [d.ref_id]
        );
        if (!own[0]) return res.status(404).json({ error: 'Client not found' });
        if (own[0].trainer_id !== req.user.trainer_id)
          return res.status(403).json({ error: 'Access denied: client is not assigned to you' });
      } else if (type === 'trainer') {
        if (d.ref_id !== req.user.trainer_id)
          return res.status(403).json({ error: 'Access denied' });
      }
      d.trainer_id = req.user.trainer_id;
    }

    const id = randomUUID();
    const checkIn = d.check_in ? new Date(d.date + 'T' + d.check_in).toISOString() : null;
    const checkOut = d.check_out ? new Date(d.date + 'T' + d.check_out).toISOString() : null;
    await pool.query(`
      INSERT INTO attendance_logs
        (id, ref_id, ref_type, ref_name, date, check_in_time, check_out_time,
         status, notes, method, marked_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (ref_id, ref_type, date) DO UPDATE
        SET status=$8,
            check_in_time=COALESCE(attendance_logs.check_in_time, $6),
            check_out_time=$7,
            notes=$9,
            method=$10,
            organization_id=COALESCE(attendance_logs.organization_id, $12)`,
      [id, d.ref_id, type, d.ref_name || null,
       d.date, checkIn, checkOut,
       d.status || 'present', d.notes || null,
       'manual', req.user.id, orgIdOf(req)]
    );
    res.status(201).json({ message: 'Attendance marked' });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/today-summary
router.get('/today-summary', auth, async (req, res, next) => {
  try {
    const params = [];
    let trainerFilter = '';
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      trainerFilter = 'AND a.ref_id IN (SELECT id FROM clients WHERE trainer_id = $' + params.length + ' UNION SELECT id FROM pt_clients WHERE trainer_id = $' + params.length + ') ';
    }
    const scope = tenantScope(req);
    let orgFilter = '';
    if (scope.applyFilter) { params.push(scope.orgId); orgFilter = 'AND a.organization_id = $' + params.length + ' '; }

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE a.status='present') AS present,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent,
        COUNT(*) FILTER (WHERE a.status='late')    AS late,
        COUNT(*)                                    AS total
      FROM attendance_logs a
      WHERE a.date = CURRENT_DATE AND a.ref_type = 'client' ${trainerFilter}${orgFilter}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/attendance/:id — update a specific attendance record
router.put('/:id', auth, async function(req, res, next) {
  try {
    const scope = tenantScope(req);
    const existGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existing } = await pool.query(
      'SELECT id, ref_id, ref_type FROM attendance_logs WHERE id = $1' + existGuard,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Attendance record not found' });

    // RBAC: trainers can only edit records belonging to their own clients
    if (req.user.role === 'trainer') {
      const { rows: own } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [existing[0].ref_id, req.user.trainer_id]
      );
      if (!own[0]) return res.status(403).json({ error: 'Access denied' });
    }

    const fields = [];
    const params = [req.params.id];
    let idx = 2;
    const d = req.body;

    if (d.status !== undefined) { fields.push('status = $' + idx++); params.push(d.status); }
    if (d.check_in !== undefined) { fields.push('check_in_time = $' + idx++); params.push(d.check_in); }
    if (d.check_out !== undefined) { fields.push('check_out_time = $' + idx++); params.push(d.check_out); }
    if (d.notes !== undefined) { fields.push('notes = $' + idx++); params.push(d.notes); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { rows } = await pool.query(
      'UPDATE attendance_logs SET ' + fields.join(', ') + ' WHERE id = $1 RETURNING id, ref_id, ref_type AS type, ref_name, date, check_in_time AS check_in, check_out_time AS check_out, status, notes, method AS check_in_method, created_at',
      params
    );
    res.json({ message: 'Attendance updated', attendance: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/attendance/:id — delete a specific attendance record
router.delete('/:id', auth, async function(req, res, next) {
  try {
    const scope = tenantScope(req);
    const existGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existing } = await pool.query(
      'SELECT id, ref_id, ref_type FROM attendance_logs WHERE id = $1' + existGuard,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Attendance record not found' });

    // RBAC: trainers can only delete records belonging to their own clients
    if (req.user.role === 'trainer') {
      const { rows: own } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [existing[0].ref_id, req.user.trainer_id]
      );
      if (!own[0]) return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM attendance_logs WHERE id = $1', [req.params.id]);
    res.json({ message: 'Attendance record deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/bulk — mark attendance for multiple members
router.post('/bulk', auth, async function(req, res, next) {
  try {
    const records = req.body.records;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required' });
    }

    if (records.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 records per bulk operation' });
    }

    const results = [];
    const errors = [];
    const bulkOrgId = orgIdOf(req);

    for (let i = 0; i < records.length; i++) {
      const d = records[i];
      if (!d.ref_id || !d.date || !d.status) {
        errors.push({ index: i, error: 'ref_id, date, and status required' });
        continue;
      }

      try {
        const type = d.type || 'client';
        const id = randomUUID();

        // RBAC: trainers scoped to own clients (gym and PT)
        if (req.user.role === 'trainer') {
          const { rows: own } = await pool.query(
            `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
             UNION
             SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
             LIMIT 1`,
            [d.ref_id, req.user.trainer_id]
          );
          if (!own[0]) {
            errors.push({ index: i, ref_id: d.ref_id, error: 'Access denied' });
            continue;
          }
        }

        const bulkCheckIn = d.check_in ? new Date(d.date + 'T' + d.check_in).toISOString() : null;
        const bulkCheckOut = d.check_out ? new Date(d.date + 'T' + d.check_out).toISOString() : null;
        await pool.query(`
          INSERT INTO attendance_logs
            (id, ref_id, ref_type, ref_name, date,
             check_in_time, check_out_time, status, notes, method, marked_by, organization_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (ref_id, ref_type, date) DO UPDATE
            SET status=$8, notes=$9,
                organization_id=COALESCE(attendance_logs.organization_id, $12)`,
          [id, d.ref_id, type, d.ref_name || null,
           d.date, bulkCheckIn, bulkCheckOut,
           d.status || 'present', d.notes || null,
           'manual', req.user.id, bulkOrgId]
        );
        results.push({ index: i, ref_id: d.ref_id, status: d.status });
      } catch (err) {
        errors.push({ index: i, ref_id: d.ref_id, error: err.message });
      }
    }

    res.status(201).json({
      message: results.length + ' records processed',
      processed: results.length,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/stats — attendance statistics for charts
// Query params: from, to, granularity (day|week|month)
router.get('/stats', auth, async function(req, res, next) {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const granularity = req.query.granularity || 'day';

    const granularityVal = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
    const dateTrunc = granularityVal === 'day' ? 'a.date' : `DATE_TRUNC('${granularityVal}', a.date)`;

    const params = [from, to];
    let trainerFilter = '';
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      trainerFilter = 'AND a.ref_id IN (SELECT id FROM clients WHERE trainer_id = $' + params.length + ' UNION SELECT id FROM pt_clients WHERE trainer_id = $' + params.length + ') ';
    }
    const scope = tenantScope(req);
    let orgFilter = '';
    if (scope.applyFilter) { params.push(scope.orgId); orgFilter = 'AND a.organization_id = $' + params.length + ' '; }

    const { rows } = await pool.query(
      'SELECT ' + dateTrunc + ' AS period, ' +
      'a.status, COUNT(*) AS count ' +
      'FROM attendance_logs a ' +
      'WHERE a.date >= $1 AND a.date <= $2 ' + trainerFilter + orgFilter +
      'AND a.ref_type = \'client\' ' +
      'GROUP BY period, a.status ' +
      'ORDER BY period ASC',
      params
    );

    // Pivot: group by period, spread statuses
    const series = {};
    for (const r of rows) {
      const key = r.period instanceof Date ? r.period.toISOString().split('T')[0] : String(r.period);
      if (!series[key]) series[key] = { date: key, present: 0, absent: 0, late: 0, total: 0 };
      series[key][r.status] = parseInt(r.count) || 0;
      series[key].total += parseInt(r.count) || 0;
    }

    res.json(Object.values(series));
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/gaps — members with attendance gaps (absent streaks)
// Query params: min_streak_days (default 3), from, to
router.get('/gaps', auth, async function(req, res, next) {
  try {
    const minStreak = parseInt(req.query.min_streak_days) || 3;
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];

    const params = [from, to, minStreak];
    let trainerFilter = '';
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      params.push(req.user.trainer_id);
      trainerFilter = 'AND c.trainer_id = $' + params.length + ' ';
    }
    // Tenant scope: the client identity list must be limited to this org. The
    // legacy `clients` table has no organization_id (it is empty in this
    // deployment), so we scope the pt_clients branch plus the attendance
    // references (a / a2). $orgIdx is reused in three places.
    const scope = tenantScope(req);
    let ptOrg = '', aOrg = '', a2Org = '';
    if (scope.applyFilter) {
      params.push(scope.orgId);
      const orgIdx = params.length;
      ptOrg = ' AND organization_id = $' + orgIdx;
      aOrg = ' AND a.organization_id = $' + orgIdx;
      a2Org = ' AND a2.organization_id = $' + orgIdx;
    }

    // Find members (gym + PT) with absent streak >= minStreak
    const { rows } = await pool.query(
      'SELECT c.id, c.name, c.mobile, c.trainer_id, ' +
      'COALESCE(t.name, \'—\') AS trainer_name, ' +
      'COUNT(a.id) FILTER (WHERE a.date >= $1::DATE) AS absent_days, ' +
      'MAX(a.date) AS last_absent_date, ' +
      '(SELECT COUNT(*) FROM attendance_logs a2 ' +
      '  WHERE a2.ref_id = c.id AND a2.ref_type = \'client\' ' +
      '  AND a2.date >= $1::DATE AND a2.date <= $2::DATE' + a2Org + ') AS total_entries ' +
      'FROM (' +
      '  SELECT id, name, mobile, trainer_id FROM clients WHERE deleted_at IS NULL AND status = \'active\' ' +
      '  UNION ALL ' +
      '  SELECT id, name, mobile, trainer_id FROM pt_clients WHERE deleted_at IS NULL AND status = \'active\'' + ptOrg +
      ') c ' +
      'LEFT JOIN attendance_logs a ON a.ref_id = c.id AND a.ref_type = \'client\' AND a.status = \'absent\'' + aOrg + ' ' +
      'LEFT JOIN trainers t ON t.id = c.trainer_id ' +
      'WHERE 1=1 ' + trainerFilter +
      'GROUP BY c.id, c.name, c.mobile, c.trainer_id, t.name ' +
      'HAVING COUNT(a.id) >= $3 ' +
      'ORDER BY absent_days DESC',
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
