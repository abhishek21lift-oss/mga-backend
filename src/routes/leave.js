// src/routes/leave.js
// Leave request management — CRUD + approve/reject workflow.
// DB table: leave_requests (schema.sql / migration 002)

const router = require('express').Router();
const pool = require('../db/pool');
const logger = require('../lib/logger');
const { auth, adminOrManager } = require('../middleware/auth');

// GET /api/leave — list leave requests
// Filters: status, trainer_id, from, to
router.get('/', auth, async function(req, res) {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.query.status) {
      conditions.push('lr.status = $' + idx++);
      params.push(req.query.status);
    }
    if (req.query.trainer_id) {
      conditions.push('lr.trainer_id = $' + idx++);
      params.push(req.query.trainer_id);
    }
    if (req.query.from) {
      conditions.push('lr.from_date >= $' + idx++);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push('lr.to_date <= $' + idx++);
      params.push(req.query.to);
    }

    // Trainers can only see their own leave requests
    if (req.user.role === 'trainer') {
      conditions.push('lr.trainer_id = $' + idx++);
      const { rows: tr } = await pool.query('SELECT id FROM trainers WHERE id = $1 OR user_id = $1', [req.user.id]);
      params.push(tr.length ? tr[0].id : req.user.trainer_id || req.user.id);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);

    const { rows } = await pool.query(
      'SELECT lr.*, t.name AS trainer_name, t.email AS trainer_email, t.mobile AS trainer_phone ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN trainers t ON t.id = lr.trainer_id ' +
      where + ' ORDER BY lr.created_at DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length,
      params
    );

    // Map fields to frontend expectations
    const result = rows.map(function(r) {
      const from = new Date(r.from_date);
      const to = new Date(r.to_date);
      return {
        id: r.id,
        trainer_id: r.trainer_id,
        trainer_name: r.trainer_name || '',
        leave_type: r.leave_type,
        from_date: r.from_date,
        to_date: r.to_date,
        reason: r.reason || '',
        admin_note: r.admin_note || '',
        status: r.status,
        approved_by: r.approved_by,
        approved_at: r.approved_at,
        days: Math.max(Math.round((to.getTime() - from.getTime()) / 86400000) + 1, 1),
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, 'Leave list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leave/:id — single leave request
router.get('/:id', auth, async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT lr.*, t.name AS trainer_name, t.email AS trainer_email ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN trainers t ON t.id = lr.trainer_id ' +
      'WHERE lr.id = $1',
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Leave request not found' });

    const r = rows[0];
    const from = new Date(r.from_date);
    const to = new Date(r.to_date);

    res.json({
      id: r.id,
      trainer_id: r.trainer_id,
      trainer_name: r.trainer_name || '',
      leave_type: r.leave_type,
      from_date: r.from_date,
      to_date: r.to_date,
      reason: r.reason || '',
      admin_note: r.admin_note || '',
      status: r.status,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      days: Math.max(Math.round((to.getTime() - from.getTime()) / 86400000) + 1, 1),
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave get error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave — create leave request
router.post('/', auth, async function(req, res) {
  try {
    const { trainer_id, leave_type, from_date, to_date, reason } = req.body;

    if (!trainer_id || !from_date || !to_date) {
      return res.status(400).json({ error: 'trainer_id, from_date, to_date are required' });
    }

    const VALID_LEAVE_TYPES = ['sick', 'casual', 'personal', 'earned', 'unpaid', 'emergency', 'other'];
    if (leave_type && !VALID_LEAVE_TYPES.includes(leave_type)) {
      return res.status(400).json({ error: 'Invalid leave_type' });
    }

    if (new Date(to_date) < new Date(from_date)) {
      return res.status(400).json({ error: 'to_date must be on or after from_date' });
    }

    // Trainers can only create leave for themselves
    if (req.user.role === 'trainer') {
      const { rows: tr } = await pool.query(
        'SELECT id FROM trainers WHERE id = $1 OR user_id = $1', [req.user.id]
      );
      const myTrainerId = tr.length ? tr[0].id : req.user.trainer_id;
      if (trainer_id !== myTrainerId) {
        return res.status(403).json({ error: 'You can only submit leave for yourself' });
      }
    }

    // Check for overlapping pending leave
    const { rows: overlap } = await pool.query(
      'SELECT id FROM leave_requests WHERE trainer_id = $1 AND status = $2 ' +
      'AND from_date <= $3 AND to_date >= $4 LIMIT 1',
      [trainer_id, 'pending', to_date, from_date]
    );

    if (overlap.length) {
      return res.status(409).json({ error: 'Overlapping leave request already exists' });
    }

    const { rows } = await pool.query(
      'INSERT INTO leave_requests (trainer_id, leave_type, from_date, to_date, reason) ' +
      'VALUES ($1, $2, $3, $4, $5) ' +
      'RETURNING *',
      [trainer_id, leave_type || 'other', from_date, to_date, reason || '']
    );

    const r = rows[0];
    res.status(201).json({
      message: 'Leave request submitted',
      leave: {
        id: r.id,
        trainer_id: r.trainer_id,
        leave_type: r.leave_type,
        from_date: r.from_date,
        to_date: r.to_date,
        reason: r.reason,
        status: r.status,
        created_at: r.created_at,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave create error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave/:id/approve — approve leave
router.post('/:id/approve', auth, adminOrManager, async function(req, res) {
  try {
    const { rows } = await pool.query(
      'UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = NOW(), ' +
      'admin_note = COALESCE($3, admin_note), updated_at = NOW() ' +
      'WHERE id = $4 AND status = $5 RETURNING *',
      ['approved', req.user.id, req.body.admin_note || null, req.params.id, 'pending']
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Leave request not found or already processed' });
    }

    res.json({ message: 'Leave approved', leave: rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave approve error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave/:id/reject — reject leave
router.post('/:id/reject', auth, adminOrManager, async function(req, res) {
  try {
    const { rows } = await pool.query(
      'UPDATE leave_requests SET status = $1, approved_by = $2, ' +
      'admin_note = COALESCE($3, admin_note), updated_at = NOW() ' +
      'WHERE id = $4 AND status = $5 RETURNING *',
      ['rejected', req.user.id, req.body.admin_note || null, req.params.id, 'pending']
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Leave request not found or already processed' });
    }

    res.json({ message: 'Leave rejected', leave: rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave reject error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
