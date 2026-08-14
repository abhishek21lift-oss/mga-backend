// src/routes/memberships.js — the gym membership lifecycle.
//
// Phase 3. Sell a period of gym access to a member, then renew, freeze, resume,
// change or cancel it. See migration 168 and docs/GMS_TARGET_ARCHITECTURE.md §3.
//
// ── Every state change is transactional, and that is not decoration ─────────
//
// A renewal writes a membership row, an event row, and reads the plan. A resume
// writes the freeze, the membership's ends_on and an event. Half of any of those
// is worse than none: a membership whose ends_on moved with no event explaining
// it, or a closed freeze that never extended the term, is a support ticket
// nobody can answer from the data.
//
// So each one borrows a client and opens a transaction. That is also enforced —
// src/__tests__/borrowedClientScope.convention.test.js fails the build if a
// borrowed client runs outside a transaction, because db/pool.js sets the tenant
// GUC on BEGIN and a borrow that never begins carries no org id at all.
//
// ── Renewal creates a new row, it does not extend the old one ───────────────
//
// The alternative — pushing ends_on out on the existing membership — loses the
// fact that a sale happened. A studio needs to count January's renewals, show a
// member what they have bought over three years, and reprint the receipt for one
// specific term. Migration 168's note on why there is no "one active membership
// per member" constraint is the other half of this: renewing before expiry is
// normal, so two non-expired rows for one member is a legitimate state and the
// current membership is the one with the latest ends_on.

'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { membershipSchemas } = require('../lib/validation');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Reception sells memberships — that is the front desk's job. Trainers read.
const canSell = requireRole('admin', 'manager', 'reception');
const canCancel = requireRole('admin', 'manager');

const COLUMNS = `id, organization_id, member_id, plan_id, plan_name,
                 starts_on, ends_on, status,
                 price, discount, joining_fee, tax_amount, total, amount_paid,
                 notes, cancelled_at, cancel_reason, created_at, updated_at`;

const NO_ORG = {
  error: { code: 'ORG_REQUIRED', message: 'Select a studio before managing memberships.' },
};

function orgWhere(req, params, alias = '') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND ${alias}organization_id = $${params.length}`;
}

/** ISO date `n` days after `from`. */
function addDays(from, n) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Price a plan into the money columns.
 *
 * Tax is charged on the discounted subtotal plus the joining fee, which is the
 * ordinary reading of an inclusive-of-fee invoice. Computed here rather than
 * taken from the request so a caller cannot post their own total.
 */
function priceOut(plan, discount = 0, includeJoiningFee = true) {
  const price = Number(plan.price) || 0;
  const disc = Math.min(Math.max(Number(discount) || 0, 0), price);
  const fee = includeJoiningFee ? Number(plan.joining_fee) || 0 : 0;
  const taxable = price - disc + fee;
  const tax = +(taxable * (Number(plan.tax_pct) || 0) / 100).toFixed(2);
  return {
    price, discount: disc, joining_fee: fee,
    tax_amount: tax, total: +(taxable + tax).toFixed(2),
  };
}

/** Fetch a plan inside the caller's organization, on a transaction client. */
async function planInOrg(client, planId, orgId) {
  const { rows } = await client.query(
    `SELECT id, name, duration_days, price, joining_fee, tax_pct
       FROM membership_plans
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [planId, orgId]
  );
  return rows[0] || null;
}

/** Fetch a membership inside the caller's organization, on a transaction client. */
async function membershipInOrg(client, id, orgId) {
  const { rows } = await client.query(
    `SELECT * FROM memberships
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [id, orgId]
  );
  return rows[0] || null;
}

async function logEvent(client, orgId, membershipId, kind, fields = {}) {
  await client.query(
    `INSERT INTO membership_events
       (organization_id, membership_id, kind, from_plan_id, to_plan_id,
        from_ends_on, to_ends_on, effective_on, amount, actor_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, CURRENT_DATE),$9,$10,$11)`,
    [
      orgId, membershipId, kind,
      fields.from_plan_id || null, fields.to_plan_id || null,
      fields.from_ends_on || null, fields.to_ends_on || null,
      fields.effective_on || null, fields.amount ?? null,
      fields.actor_id || null, fields.note || null,
    ]
  );
}

// ── GET /api/memberships ────────────────────────────────────────────────────
router.get('/', auth, wrap(async (req, res) => {
  const conds = ['ms.deleted_at IS NULL'];
  const params = [];

  const org = orgWhere(req, params, 'ms.');
  if (org) conds.push(org.replace(/^ AND /, ''));

  if (req.query.member_id) { params.push(req.query.member_id); conds.push(`ms.member_id = $${params.length}`); }
  if (req.query.status)    { params.push(req.query.status);    conds.push(`ms.status = $${params.length}`); }

  // `expiring_in=7` is the front desk's daily question and the reminder
  // worker's. Served by idx_memberships_expiry.
  if (req.query.expiring_in) {
    const days = Math.min(Math.max(parseInt(req.query.expiring_in, 10) || 0, 0), 365);
    params.push(days);
    conds.push(`ms.status = 'active' AND ms.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE + $${params.length}::int`);
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT ms.*, m.name AS member_name, m.member_code, m.mobile AS member_mobile
       FROM memberships ms
       JOIN members m ON m.id = ms.member_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ms.ends_on DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ data: rows, limit, offset });
}));

// ── GET /api/memberships/:id ────────────────────────────────────────────────
router.get('/:id', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM memberships WHERE id = $1 AND deleted_at IS NULL${org}`, params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });

  // Children are addressed by membership_id, which the query above has already
  // proved belongs to the caller. Both carry their own organization_id too, so
  // the predicate is applied anyway rather than relying on the parent — the
  // RELATIONSHIP caveat in TENANT_SECURITY_AUDIT.md §1.2 is that parent-gating
  // holds only while every call site remembers to do it.
  const [events, freezes] = await Promise.all([
    pool.query(
      `SELECT kind, from_plan_id, to_plan_id, from_ends_on, to_ends_on,
              effective_on, amount, note, created_at
         FROM membership_events WHERE membership_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    ),
    pool.query(
      `SELECT id, from_date, to_date, days, reason, resumed_at, created_at
         FROM membership_freezes WHERE membership_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    ),
  ]);

  res.json({ data: { ...rows[0], events: events.rows, freezes: freezes.rows } });
}));

// ── POST /api/memberships — sell a membership ───────────────────────────────
router.post('/', auth, canSell, validate(membershipSchemas.create), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The member must be the caller's. Without this the membership lands in the
    // caller's org pointing at a foreign member — the referential pollution
    // lib/orgGuard.js exists to prevent for PT clients.
    const { rowCount: memberOk } = await client.query(
      'SELECT 1 FROM members WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [b.member_id, orgId]
    );
    if (!memberOk) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    }

    const plan = await planInOrg(client, b.plan_id, orgId);
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    }

    const startsOn = b.starts_on || today();
    // duration_days - 1: a 30-day plan starting on the 1st ends on the 30th,
    // not the 31st. Off by one here is 12 free days a year on a monthly plan.
    const endsOn = b.ends_on || addDays(startsOn, plan.duration_days - 1);
    const money = priceOut(plan, b.discount, b.include_joining_fee !== false);

    const { rows } = await client.query(
      `INSERT INTO memberships
         (organization_id, member_id, plan_id, plan_name, starts_on, ends_on, status,
          price, discount, joining_fee, tax_amount, total, amount_paid, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${COLUMNS}`,
      [
        orgId, b.member_id, plan.id, plan.name, startsOn, endsOn,
        b.status || 'active',
        money.price, money.discount, money.joining_fee, money.tax_amount, money.total,
        b.amount_paid ?? 0, b.notes || null, req.user.id,
      ]
    );

    await logEvent(client, orgId, rows[0].id, 'created', {
      to_plan_id: plan.id, to_ends_on: endsOn, effective_on: startsOn,
      amount: money.total, actor_id: req.user.id,
    });

    await client.query('COMMIT');
    logger.info({ orgId, membershipId: rows[0].id, memberId: b.member_id }, 'membership sold');
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ── POST /api/memberships/:id/renew ─────────────────────────────────────────
router.post('/:id/renew', auth, canSell, validate(membershipSchemas.renew), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await membershipInOrg(client, req.params.id, orgId);
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }

    // Renewing onto the same plan by default; a different plan_id is a change
    // of plan at renewal, which is ordinary.
    const plan = await planInOrg(client, req.body.plan_id || current.plan_id, orgId);
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    }

    // Continue from the day after the current term, unless it already lapsed —
    // then start today. Back-dating a renewal to an expired term's end would
    // sell the member days that have already passed.
    const currentEnd = current.ends_on.toISOString
      ? current.ends_on.toISOString().slice(0, 10)
      : String(current.ends_on).slice(0, 10);
    const startsOn = req.body.starts_on
      || (currentEnd >= today() ? addDays(currentEnd, 1) : today());
    const endsOn = addDays(startsOn, plan.duration_days - 1);

    // No joining fee on a renewal — it is a joining fee.
    const money = priceOut(plan, req.body.discount, false);

    const { rows } = await client.query(
      `INSERT INTO memberships
         (organization_id, member_id, plan_id, plan_name, starts_on, ends_on, status,
          price, discount, joining_fee, tax_amount, total, amount_paid, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,0,$9,$10,$11,$12,$13)
       RETURNING ${COLUMNS}`,
      [
        orgId, current.member_id, plan.id, plan.name, startsOn, endsOn,
        money.price, money.discount, money.tax_amount, money.total,
        req.body.amount_paid ?? 0, req.body.notes || null, req.user.id,
      ]
    );

    await logEvent(client, orgId, rows[0].id, 'renewed', {
      from_plan_id: current.plan_id, to_plan_id: plan.id,
      from_ends_on: currentEnd, to_ends_on: endsOn,
      effective_on: startsOn, amount: money.total, actor_id: req.user.id,
      note: `Renewed from membership ${current.id}`,
    });

    await client.query('COMMIT');
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ── POST /api/memberships/:id/freeze ────────────────────────────────────────
router.post('/:id/freeze', auth, canSell, validate(membershipSchemas.freeze), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ms = await membershipInOrg(client, req.params.id, orgId);
    if (!ms) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }
    if (ms.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'NOT_ACTIVE', message: `Only an active membership can be frozen (this one is ${ms.status}).` },
      });
    }

    const fromDate = req.body.from_date || today();
    await client.query(
      `INSERT INTO membership_freezes (organization_id, membership_id, from_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, ms.id, fromDate, req.body.reason || null, req.user.id]
    );

    const { rows } = await client.query(
      `UPDATE memberships SET status = 'frozen', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 RETURNING ${COLUMNS}`,
      [ms.id, orgId]
    );

    await logEvent(client, orgId, ms.id, 'frozen', {
      effective_on: fromDate, actor_id: req.user.id, note: req.body.reason || null,
    });

    await client.query('COMMIT');
    res.json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // uq_membership_freezes_open — one open freeze at a time, or the resume
    // arithmetic has no single freeze to attribute the extension to.
    if (err.code === '23505' && /uq_membership_freezes_open/.test(err.constraint || '')) {
      return res.status(409).json({
        error: { code: 'ALREADY_FROZEN', message: 'This membership already has an open freeze.' },
      });
    }
    throw err;
  } finally {
    client.release();
  }
}));

// ── POST /api/memberships/:id/resume ────────────────────────────────────────
//
// Closes the open freeze and pushes ends_on out by the days frozen, so the
// member does not lose time they paid for. The extension is computed from the
// dates rather than trusted from the request.
router.post('/:id/resume', auth, canSell, validate(membershipSchemas.resume), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ms = await membershipInOrg(client, req.params.id, orgId);
    if (!ms) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }

    const { rows: openRows } = await client.query(
      `SELECT id, from_date FROM membership_freezes
        WHERE membership_id = $1 AND organization_id = $2 AND resumed_at IS NULL
        FOR UPDATE`,
      [ms.id, orgId]
    );
    const open = openRows[0];
    if (!open) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'NOT_FROZEN', message: 'This membership has no open freeze.' },
      });
    }

    const toDate = req.body.to_date || today();

    // Inclusive of both ends: frozen on the 10th and resumed on the 10th is one
    // day lost, so one day is added back. GREATEST(...,0) guards a resume
    // back-dated before the freeze started, which the CHECK also rejects — the
    // clamp is here so a bad request cannot produce a negative extension.
    const { rows: [calc] } = await client.query(
      `SELECT GREATEST(($1::date - $2::date) + 1, 0)::int AS days`,
      [toDate, open.from_date]
    );
    const days = calc.days;

    await client.query(
      `UPDATE membership_freezes SET to_date = $1, days = $2, resumed_at = NOW()
        WHERE id = $3 AND organization_id = $4`,
      [toDate, days, open.id, orgId]
    );

    const { rows } = await client.query(
      `UPDATE memberships
          SET ends_on = ends_on + $1::int, status = 'active', updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING ${COLUMNS}`,
      [days, ms.id, orgId]
    );

    await logEvent(client, orgId, ms.id, 'resumed', {
      from_ends_on: ms.ends_on, to_ends_on: rows[0].ends_on,
      effective_on: toDate, actor_id: req.user.id,
      note: `Frozen ${days} day${days === 1 ? '' : 's'}`,
    });

    await client.query('COMMIT');
    res.json({ data: rows[0], frozen_days: days });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ── POST /api/memberships/:id/change-plan — upgrade or downgrade ────────────
//
// Changes the plan on the CURRENT term and re-dates the end from the original
// start, so a member upgrading mid-term gets the new plan's full duration from
// where they began rather than a new term stacked on top. Whether it is an
// upgrade or a downgrade is derived from the price, not taken from the caller.
router.post('/:id/change-plan', auth, canSell, validate(membershipSchemas.changePlan), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ms = await membershipInOrg(client, req.params.id, orgId);
    if (!ms) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }
    if (!['active', 'frozen'].includes(ms.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'NOT_CHANGEABLE', message: `A ${ms.status} membership cannot change plan.` },
      });
    }

    const plan = await planInOrg(client, req.body.plan_id, orgId);
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    }
    if (plan.id === ms.plan_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'SAME_PLAN', message: 'The membership is already on that plan.' },
      });
    }

    const startsOn = ms.starts_on.toISOString
      ? ms.starts_on.toISOString().slice(0, 10)
      : String(ms.starts_on).slice(0, 10);
    const endsOn = addDays(startsOn, plan.duration_days - 1);
    const money = priceOut(plan, req.body.discount, false);
    const kind = Number(plan.price) >= Number(ms.price) ? 'upgraded' : 'downgraded';

    const { rows } = await client.query(
      `UPDATE memberships
          SET plan_id = $1, plan_name = $2, ends_on = $3,
              price = $4, discount = $5, tax_amount = $6, total = $7, updated_at = NOW()
        WHERE id = $8 AND organization_id = $9
        RETURNING ${COLUMNS}`,
      [plan.id, plan.name, endsOn, money.price, money.discount, money.tax_amount,
        money.total, ms.id, orgId]
    );

    await logEvent(client, orgId, ms.id, kind, {
      from_plan_id: ms.plan_id, to_plan_id: plan.id,
      from_ends_on: ms.ends_on, to_ends_on: endsOn,
      amount: money.total, actor_id: req.user.id, note: req.body.note || null,
    });

    await client.query('COMMIT');
    res.json({ data: rows[0], change: kind });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ── POST /api/memberships/:id/cancel ────────────────────────────────────────
router.post('/:id/cancel', auth, canCancel, validate(membershipSchemas.cancel), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) return res.status(400).json(NO_ORG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ms = await membershipInOrg(client, req.params.id, orgId);
    if (!ms) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }
    if (ms.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { code: 'ALREADY_CANCELLED', message: 'This membership is already cancelled.' },
      });
    }

    const { rows } = await client.query(
      `UPDATE memberships
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_reason = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING ${COLUMNS}`,
      [req.body.reason || null, ms.id, orgId]
    );

    // Any open freeze is closed with it, or uq_membership_freezes_open blocks a
    // future freeze on a membership nobody can resume.
    await client.query(
      `UPDATE membership_freezes SET resumed_at = NOW(), to_date = COALESCE(to_date, CURRENT_DATE)
        WHERE membership_id = $1 AND organization_id = $2 AND resumed_at IS NULL`,
      [ms.id, orgId]
    );

    await logEvent(client, orgId, ms.id, 'cancelled', {
      from_plan_id: ms.plan_id, from_ends_on: ms.ends_on,
      actor_id: req.user.id, note: req.body.reason || null,
    });

    await client.query('COMMIT');
    logger.info({ orgId, membershipId: ms.id, by: req.user.id }, 'membership cancelled');
    res.json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
