// src/routes/plans.js  — CRUD for membership plans
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { planSchemas } = require('../lib/validation');

// GET /api/plans
router.get('/', auth, async (req, res, next) => {
  try {
    const { kind, active } = req.query;
    const conds = ['deleted_at IS NULL'];
    const params = [];
    let p = 1;
    if (kind)              { conds.push(`kind = $${p++}`);       params.push(kind); }
    if (active !== undefined) { conds.push(`is_active = $${p++}`); params.push(active !== 'false'); }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM plans WHERE ${conds.join(' AND ')} ORDER BY kind, duration, final_amount LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// POST /api/plans  (admin only)
router.post('/', auth, adminOnly, validate(planSchemas.create), async (req, res, next) => {
  try {
    const d = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!d.name?.trim())
      return res.status(400).json({ error: 'Plan name is required' });

    const base    = parseFloat(d.base_amount)   || 0;
    const disc    = parseFloat(d.discount)      || 0;
    const final   = parseFloat(d.final_amount)  || Math.max(0, base - disc);
    const joining = parseFloat(d.joining_fee)   || 0;
    const taxPct  = d.tax_pct !== undefined ? parseFloat(d.tax_pct) : 18;

    if (final < 0)
      return res.status(400).json({ error: 'Final amount cannot be negative' });

    const features = Array.isArray(d.features)
      ? JSON.stringify(d.features)
      : (d.features || '[]');

    // Frontend sends `status: 'active'|'draft'` — map to is_active boolean
    let isActive = true;
    if (d.is_active !== undefined)    isActive = Boolean(d.is_active);
    else if (d.status !== undefined)  isActive = d.status !== 'draft';

    const id = randomUUID();

    const { rows } = await pool.query(
      `INSERT INTO plans
         (id, kind, name, description, duration,
          base_amount, discount, final_amount, joining_fee, tax_pct,
          sessions_per_week, features, popular, color, is_active)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id,
        d.kind        || 'Membership',
        d.name.trim(),
        d.description || null,
        d.duration    || 'Monthly',
        base, disc, final, joining, taxPct,
        d.sessions_per_week ? parseInt(d.sessions_per_week) : null,
        features,
        Boolean(d.popular),
        d.color || 'violet',
        isActive,
      ]
    );
    res.status(201).json({ message: 'Plan created', plan: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/plans/:id  (admin only)
router.put('/:id', auth, adminOnly, validate(planSchemas.update), async (req, res, next) => {
  try {
    const d = req.body;
    const { rows: ex } = await pool.query('SELECT * FROM plans WHERE id=$1', [req.params.id]);
    if (!ex[0]) return res.status(404).json({ error: 'Plan not found' });

    // Safe numeric coerce: only override if the field is actually present
    const numField = (key) =>
      d[key] !== undefined && d[key] !== null && d[key] !== ''
        ? parseFloat(d[key])
        : ex[0][key];

    const base    = numField('base_amount');
    const disc    = numField('discount');
    const final   = numField('final_amount');
    const joining = numField('joining_fee');
    const taxPct  = numField('tax_pct');

    const features = Array.isArray(d.features)
      ? JSON.stringify(d.features)
      : (d.features !== undefined ? d.features : JSON.stringify(ex[0].features ?? []));

    // status → is_active mapping
    let isActive = ex[0].is_active;
    if (d.is_active !== undefined)   isActive = Boolean(d.is_active);
    else if (d.status !== undefined) isActive = d.status !== 'draft';

    const { rows } = await pool.query(
      `UPDATE plans SET
         kind=$1, name=$2, description=$3, duration=$4,
         base_amount=$5, discount=$6, final_amount=$7,
         joining_fee=$8, tax_pct=$9,
         sessions_per_week=$10, features=$11,
         popular=$12, color=$13, is_active=$14,
         updated_at=NOW()
       WHERE id=$15 RETURNING *`,
      [
        d.kind        || ex[0].kind,
        (d.name       || ex[0].name).trim(),
        d.description !== undefined ? d.description : ex[0].description,
        d.duration    || ex[0].duration,
        base, disc, final, joining, taxPct,
        d.sessions_per_week ? parseInt(d.sessions_per_week) : ex[0].sessions_per_week,
        features,
        Boolean(d.popular ?? ex[0].popular),
        d.color || ex[0].color || 'violet',
        isActive,
        req.params.id,
      ]
    );
    res.json({ message: 'Plan updated', plan: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/plans/:id  (admin only) — soft delete
router.delete('/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE plans SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
