// src/routes/membership-plans.js — the gym's membership plan catalogue.
//
// Phase 3. What a studio sells: a period of gym access at a price.
//
// ── Not /api/plans, and not a replacement for it yet ────────────────────────
//
// `plans` is the pre-multi-tenant catalogue. It has no organization_id, so
// GET /api/plans returns every studio's plan names and pricing, and its PUT and
// DELETE address rows by id alone — V-03 in TENANT_SECURITY_AUDIT.md, one of the
// sixteen findings gated on a read-only production count.
//
// This is a new table (migration 168), org-scoped NOT NULL from birth, starting
// empty. `plans` is deliberately left exactly as it is: its rows were each
// created by ONE studio and nothing records which, so they cannot be attributed
// and must not be guessed at. Phase 2a could fan `system_settings` out without a
// count because those values were shared by design; this is the opposite case.
//
// Retiring /api/plans is a separate change that needs that count, plus
// repointing the live UPI checkout path which reads it at upi-payments.js:359.

'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { membershipPlanSchemas } = require('../lib/validation');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const COLUMNS = `id, organization_id, name, description, duration_days,
                 price, joining_fee, tax_pct, is_active, sort_order,
                 created_at, updated_at`;

function orgWhere(req, params) {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND organization_id = $${params.length}`;
}

const NO_ORG = {
  error: { code: 'ORG_REQUIRED', message: 'Select a studio before managing plans.' },
};

// ── GET /api/membership-plans ───────────────────────────────────────────────
router.get('/', auth, wrap(async (req, res) => {
  const conds = ['deleted_at IS NULL'];
  const params = [];

  const org = orgWhere(req, params);
  if (org) conds.push(org.replace(/^ AND /, ''));

  // `active=true` is what a sale screen wants; the catalogue screen wants all.
  if (req.query.active !== undefined) {
    params.push(req.query.active !== 'false');
    conds.push(`is_active = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM membership_plans
      WHERE ${conds.join(' AND ')}
      ORDER BY sort_order, duration_days, name`,
    params
  );
  res.json({ data: rows });
}));

// ── GET /api/membership-plans/:id ───────────────────────────────────────────
router.get('/:id', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM membership_plans WHERE id = $1 AND deleted_at IS NULL${org}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
  res.json({ data: rows[0] });
}));

// ── POST /api/membership-plans ──────────────────────────────────────────────
router.post('/', auth, adminOnly, validate(membershipPlanSchemas.create), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const b = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO membership_plans
         (organization_id, name, description, duration_days, price, joining_fee, tax_pct, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${COLUMNS}`,
      [
        orgId, b.name, b.description || null, b.duration_days,
        b.price ?? 0, b.joining_fee ?? 0, b.tax_pct ?? 18,
        b.is_active ?? true, b.sort_order ?? 0,
      ]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    // uq_membership_plans_org_name is scoped per studio, so this fires only on a
    // real duplicate inside the caller's own catalogue — two studios may both
    // have a "Basic".
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'PLAN_EXISTS', message: 'A plan with this name already exists.' },
      });
    }
    throw err;
  }
}));

// ── PUT /api/membership-plans/:id ───────────────────────────────────────────
router.put('/:id', auth, adminOnly, validate(membershipPlanSchemas.update), wrap(async (req, res) => {
  const allowed = ['name', 'description', 'duration_days', 'price', 'joining_fee',
    'tax_pct', 'is_active', 'sort_order'];

  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'Nothing to update' } });
  sets.push('updated_at = NOW()');

  // Predicate in the UPDATE's own WHERE, not in a preceding lookup.
  const org = orgWhere(req, params);

  try {
    const { rows } = await pool.query(
      `UPDATE membership_plans SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL${org}
        RETURNING ${COLUMNS}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    res.json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'PLAN_EXISTS', message: 'A plan with this name already exists.' },
      });
    }
    throw err;
  }
}));

// ── DELETE /api/membership-plans/:id ────────────────────────────────────────
//
// Soft delete, and existing memberships are untouched by design.
//
// memberships.plan_id is ON DELETE SET NULL and memberships.plan_name holds a
// snapshot of what was sold, so retiring a plan cannot rewrite history or block
// on it. A member on a retired plan keeps their term and their receipt still
// says what they bought.
router.delete('/:id', auth, adminOnly, wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE membership_plans SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL${org} RETURNING id`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
  res.json({ data: { id: rows[0].id } });
}));

module.exports = router;
