const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// GET /api/expenses — list expenses with optional filters
// ISSUE-030: excludes soft-deleted rows (deleted_at IS NULL).
router.get('/', auth, async (req, res, next) => {
  try {
    const { from, to, category, status, limit: qLimit, offset } = req.query;
    const conditions = ['1=1', 'e.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer') {
      conditions.push(`created_by = $${p++}`);
      params.push(req.user.id);
    }

    if (from)     { conditions.push(`expense_date >= $${p++}`); params.push(from); }
    if (to)       { conditions.push(`expense_date <= $${p++}`); params.push(to); }
    if (category) { conditions.push(`category = $${p++}`);      params.push(category); }
    if (status)   { conditions.push(`status = $${p++}`);        params.push(status); }

    const scope = tenantScope(req);
    if (scope.applyFilter) { conditions.push(`e.organization_id = $${p++}`); params.push(scope.orgId); }

    params.push(Math.min(parseInt(qLimit) || 200, 1000));
    params.push(parseInt(offset) || 0);

    const { rows } = await pool.query(
      `SELECT e.*, u.name AS created_by_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      params
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM expenses e WHERE ${conditions.join(' AND ')}`,
      params.slice(0, p - 2)
    );

    res.json({ expenses: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    next(err);
  }
});

// GET /api/expenses/stats — aggregated expense stats
// ISSUE-030: excludes soft-deleted rows.
router.get('/stats', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const conditions = ['1=1', 'e.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    if (from) { conditions.push(`expense_date >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`expense_date <= $${p++}`); params.push(to); }

    const scope = tenantScope(req);
    if (scope.applyFilter) { conditions.push(`e.organization_id = $${p++}`); params.push(scope.orgId); }

    const { rows: totals } = await pool.query(
      `SELECT
         COUNT(*) AS total_expenses,
         COALESCE(SUM(amount), 0) AS total_amount,
         COALESCE(AVG(amount), 0) AS avg_amount
       FROM expenses e
       WHERE ${conditions.join(' AND ')} AND status = 'approved'`,
      params
    );

    const { rows: byCategory } = await pool.query(
      `SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM expenses e
       WHERE ${conditions.join(' AND ')} AND status = 'approved'
       GROUP BY category ORDER BY total DESC`,
      params
    );

    res.json({ summary: totals[0], byCategory });
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses — create a new expense
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.amount || d.amount <= 0)
      return res.status(400).json({ error: 'amount is required and must be positive' });
    if (!d.description)
      return res.status(400).json({ error: 'description is required' });

    const { rows } = await pool.query(
      `INSERT INTO expenses (category, description, amount, expense_date, payment_method, receipt_url, notes, created_by, status, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        d.category || 'other',
        d.description,
        d.amount,
        d.expense_date || new Date().toISOString().split('T')[0],
        d.payment_method || 'cash',
        d.receipt_url || null,
        d.notes || null,
        req.user.id,
        d.status || 'approved',
        orgIdOf(req),
      ]
    );
    res.status(201).json({ message: 'Expense created', expense: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/expenses/:id — get a single expense
// ISSUE-030: excludes soft-deleted rows.
router.get('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND e.organization_id = $2' : '';
    const { rows } = await pool.query(
      `SELECT e.*, u.name AS created_by_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1 AND e.deleted_at IS NULL${guard}`,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Expense not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/:id — update an expense
// ISSUE-030: also checks deleted_at IS NULL so soft-deleted expenses cannot be updated.
router.put('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const existGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existing } = await pool.query(
      'SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL' + existGuard,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Expense not found' });

    // Only the creator or admin/manager can edit
    if (req.user.role === 'trainer' && existing[0].created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const fields = [];
    const params = [req.params.id];
    let idx = 2;
    const d = req.body;

    for (const key of ['category', 'description', 'amount', 'expense_date', 'payment_method', 'receipt_url', 'notes', 'status']) {
      if (d[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(d[key]);
      }
    }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { rows } = await pool.query(
      `UPDATE expenses SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      params
    );
    res.json({ message: 'Expense updated', expense: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/expenses/:id — soft-delete an expense
// ISSUE-030: changed from hard DELETE to soft delete via deleted_at timestamp.
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const existGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existing } = await pool.query(
      'SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL' + existGuard,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Expense not found' });

    if (req.user.role === 'trainer' && existing[0].created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('UPDATE expenses SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
