'use strict';
// Plans, coupons and subscription changes — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, invalidateUserCache, pool, subscription,
} = require('./shared');
// GET /subscriptions — every studio's billing state + platform KPIs.
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { rows: studios } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.logo_url, o.status, o.subscription_status,
             o.trial_ends_at, o.current_period_start, o.current_period_end,
             o.plan_code, o.client_limit, o.is_founder, o.founder_number, o.locked_price_inr,
             o.created_at, p.name AS plan_name,
             (SELECT count(*) FROM pt_clients c WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int AS client_count,
             req.created_at AS requested_at, req.plan_code AS requested_plan_code,
             req.direction AS requested_direction, rp.name AS requested_plan_name
        FROM organizations o
        LEFT JOIN subscription_plans p ON p.code = o.plan_code
        -- Latest pending ask, whether it's a first activation or a plan
        -- change on an already-active studio — both go through the same
        -- operator queue (routes/subscription.js), so both must surface here.
        LEFT JOIN LATERAL (
          SELECT e.created_at, e.data->>'plan_code' AS plan_code, e.data->>'direction' AS direction
            FROM subscription_events e
           WHERE e.organization_id = o.id
             AND e.event IN ('activation_requested', 'change_requested')
             AND e.created_at > COALESCE(o.current_period_start, 'epoch'::timestamptz)
           ORDER BY e.created_at DESC LIMIT 1
        ) req ON true
        LEFT JOIN subscription_plans rp ON rp.code = req.plan_code
       ORDER BY o.created_at DESC`);

    const withState = studios.map((s) => {
      const access = subscription.computeAccess({
        status: s.status, subscription_status: s.subscription_status,
        trial_ends_at: s.trial_ends_at, current_period_end: s.current_period_end,
      });
      return { ...s, effective_state: access.state, allowed: access.allowed,
        trial_days_left: access.trialDaysLeft ?? null, period_days_left: access.periodDaysLeft ?? null,
        renewal_due: access.renewalDue ?? false };
    });

    const { rows: [rev] } = await pool.query(`
      SELECT COALESCE(SUM(amount_inr) FILTER (WHERE status='paid'), 0)::int AS total_revenue,
             COALESCE(SUM(amount_inr) FILTER (WHERE status='paid' AND created_at >= date_trunc('month', now())), 0)::int AS revenue_this_month,
             count(*) FILTER (WHERE status='paid')::int AS payment_count
        FROM subscription_payments`);
    const slots = await subscription.founderSlotsRemaining();

    const kpis = {
      studios: withState.length,
      trial: withState.filter((s) => s.effective_state === 'trial').length,
      active: withState.filter((s) => s.effective_state === 'active').length,
      frozen: withState.filter((s) => ['frozen', 'trial_expired', 'expired', 'cancelled'].includes(s.effective_state)).length,
      founders: withState.filter((s) => s.is_founder).length,
      total_revenue: rev.total_revenue,
      revenue_this_month: rev.revenue_this_month,
      founder_slots_remaining: slots,
    };
    res.json({ data: { studios: withState, kpis } });
  } catch (err) { next(err); }
});

// ── Coupons ───────────────────────────────────────────────────────────────────
// times_redeemed is derived from the redemption ledger rather than kept as a
// counter on the coupon, so it cannot drift out of step with reality.
router.get('/coupons', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
             (SELECT count(*) FROM subscription_coupon_redemptions r WHERE r.coupon_id = c.id)::int AS times_redeemed,
             (SELECT COALESCE(SUM(r.discount_inr), 0) FROM subscription_coupon_redemptions r WHERE r.coupon_id = c.id)::int AS total_discount_inr
        FROM subscription_coupons c
       ORDER BY c.created_at DESC`);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// GET /coupons/:id/redemptions — who used it, when, and for how much.
router.get('/coupons/:id/redemptions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, o.name AS organization_name
        FROM subscription_coupon_redemptions r
        LEFT JOIN organizations o ON o.id = r.organization_id
       WHERE r.coupon_id = $1
       ORDER BY r.redeemed_at DESC`, [req.params.id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/coupons', async (req, res, next) => {
  try {
    const {
      code, description, discount_type, discount_value, max_discount_inr,
      min_amount_inr, applies_to_plans, max_redemptions, max_per_org,
      valid_from, valid_until,
    } = req.body;

    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'code is required' } });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: "discount_type must be 'percent' or 'fixed'" } });
    }
    const value = Number(discount_value);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'discount_value must be greater than 0' } });
    }
    if (discount_type === 'percent' && value > 100) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A percentage discount cannot exceed 100' } });
    }

    const { rows } = await pool.query(`
      INSERT INTO subscription_coupons
        (code, description, discount_type, discount_value, max_discount_inr, min_amount_inr,
         applies_to_plans, max_redemptions, max_per_org, valid_from, valid_until,
         created_by, created_by_name)
      VALUES (upper(trim($1)),$2,$3,$4,$5,$6,$7,$8,COALESCE($9,1),$10,$11,$12,$13)
      RETURNING *`,
      [code, description || null, discount_type, value,
       max_discount_inr != null ? Number(max_discount_inr) : null,
       min_amount_inr != null ? Number(min_amount_inr) : null,
       Array.isArray(applies_to_plans) && applies_to_plans.length ? applies_to_plans : null,
       max_redemptions != null ? Number(max_redemptions) : null,
       max_per_org != null ? Number(max_per_org) : null,
       valid_from || null, valid_until || null,
       req.user.id, req.user.name || null]
    );
    await audit(req, 'coupon_created', 'coupon', rows[0].id, { code: rows[0].code });
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A coupon with that code already exists' } });
    }
    next(err);
  }
});

// PATCH /coupons/:id — edit terms or deactivate. Past redemptions are never
// rewritten: the ledger records what was actually granted at the time.
router.patch('/coupons/:id', async (req, res, next) => {
  try {
    const allowed = ['description', 'is_active', 'max_redemptions', 'max_per_org', 'valid_from', 'valid_until', 'min_amount_inr', 'max_discount_inr'];
    const sets = [];
    const params = [req.params.id];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE subscription_coupons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
    await audit(req, 'coupon_updated', 'coupon', req.params.id, req.body);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /coupons/:id — only while unused. Once redeemed a coupon is part of the
// billing record, so it is deactivated instead of deleted.
router.delete('/coupons/:id', async (req, res, next) => {
  try {
    const { rows: [used] } = await pool.query(
      'SELECT count(*)::int AS n FROM subscription_coupon_redemptions WHERE coupon_id = $1', [req.params.id]
    );
    if (used.n > 0) {
      return res.status(409).json({
        error: {
          code: 'COUPON_IN_USE',
          message: `This coupon has been redeemed ${used.n} time${used.n === 1 ? '' : 's'} and is part of the billing record. Deactivate it instead.`,
        },
      });
    }
    const { rowCount } = await pool.query('DELETE FROM subscription_coupons WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
    await audit(req, 'coupon_deleted', 'coupon', req.params.id, {});
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

// GET /subscription-metrics — SaaS health for the command centre.
//
// MRR is a RUN-RATE, not cash collected: each active subscription's recurring
// price normalised to one month. It deliberately ignores proration credits and
// one-off adjustments, which move cash but not the underlying run-rate. A
// founder's locked price is their recurring price, so locked_price_inr wins
// over the list price where present. Grandfathered studios (no plan) contribute
// nothing, which is correct — they pay nothing.
router.get('/subscription-metrics', async (req, res, next) => {
  try {
    const [mrrRow, planMix, states, conversion, founders, revenueTrend, growth] = await Promise.all([
      // Run-rate across everything currently entitled to service.
      pool.query(`
        SELECT
          COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                       / NULLIF(p.duration_months, 0)), 0)::int AS mrr_inr,
          count(*)::int AS paying_studios,
          COALESCE(AVG(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                       / NULLIF(p.duration_months, 0)), 0)::int AS arpu_inr
          FROM organizations o
          JOIN subscription_plans p ON p.code = o.plan_code
         WHERE o.subscription_status = 'active'
           AND o.status <> 'suspended'
           AND (o.current_period_end IS NULL OR o.current_period_end > now())`),

      // Distribution of paying studios across the catalogue.
      pool.query(`
        SELECT p.code, p.name, p.price_inr, p.duration_months,
               count(o.id)::int AS studios,
               COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                            / NULLIF(p.duration_months, 0)), 0)::int AS mrr_inr
          FROM subscription_plans p
          LEFT JOIN organizations o
                 ON o.plan_code = p.code
                AND o.subscription_status = 'active'
                AND o.status <> 'suspended'
                AND (o.current_period_end IS NULL OR o.current_period_end > now())
         GROUP BY p.code, p.name, p.price_inr, p.duration_months, p.sort_order
         ORDER BY p.sort_order NULLS LAST, p.price_inr`),

      // Lifecycle spread. Timestamp-aware so a lapsed row that the worker has
      // not swept yet is still reported as expired.
      pool.query(`
        SELECT
          count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'trial'
                             AND (trial_ends_at IS NULL OR trial_ends_at > now()))::int AS on_trial,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'trial'
                             AND trial_ends_at IS NOT NULL AND trial_ends_at <= now())::int AS trial_lapsed,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'active'
                             AND (current_period_end IS NULL OR current_period_end > now()))::int AS active,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'active'
                             AND current_period_end IS NOT NULL AND current_period_end <= now())::int AS lapsed,
          count(*) FILTER (WHERE subscription_status = 'frozen')::int AS frozen,
          count(*) FILTER (WHERE subscription_status = 'expired')::int AS expired,
          count(*) FILTER (WHERE subscription_status = 'cancelled')::int AS cancelled,
          count(*)::int AS total
          FROM organizations`),

      // Trial → paid conversion, scoped to studios that actually ran a trial.
      // Grandfathered studios never had one and would otherwise skew this.
      pool.query(`
        WITH trials AS (
          SELECT DISTINCT organization_id, min(created_at) AS started_at
            FROM subscription_events WHERE event = 'trial_started'
           GROUP BY organization_id
        ), converted AS (
          SELECT DISTINCT t.organization_id
            FROM trials t
            JOIN subscription_events e
              ON e.organization_id = t.organization_id
             AND e.event = 'activated'
             AND e.created_at >= t.started_at
        )
        SELECT (SELECT count(*) FROM trials)::int    AS trials_started,
               (SELECT count(*) FROM converted)::int AS trials_converted`),

      pool.query(`
        SELECT count(*)::int AS granted,
               COALESCE(SUM(locked_price_inr), 0)::int AS locked_value_inr,
               MAX(founder_number)::int AS highest_number
          FROM founder_members`),

      // Cash actually collected, last 12 months.
      pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'Mon YYYY') AS label,
               date_trunc('month', created_at)::date AS month,
               COALESCE(SUM(amount_inr) FILTER (WHERE status = 'paid'), 0)::int AS revenue_inr,
               count(*) FILTER (WHERE status = 'paid')::int AS payments,
               COALESCE(SUM(amount_inr) FILTER (WHERE status = 'refunded'), 0)::int AS refunded_inr
          FROM subscription_payments
         WHERE created_at >= date_trunc('month', now()) - interval '11 months'
         GROUP BY 1, 2 ORDER BY 2`),

      // New paying studios per month — first activation only, so renewals do
      // not inflate it.
      pool.query(`
        WITH first_activation AS (
          SELECT organization_id, min(created_at) AS activated_at
            FROM subscription_events WHERE event = 'activated'
           GROUP BY organization_id
        )
        SELECT to_char(date_trunc('month', activated_at), 'Mon YYYY') AS label,
               date_trunc('month', activated_at)::date AS month,
               count(*)::int AS new_studios
          FROM first_activation
         WHERE activated_at >= date_trunc('month', now()) - interval '11 months'
         GROUP BY 1, 2 ORDER BY 2`),
    ]);

    const mrr = mrrRow.rows[0] || { mrr_inr: 0, paying_studios: 0, arpu_inr: 0 };
    const conv = conversion.rows[0] || { trials_started: 0, trials_converted: 0 };
    const f = founders.rows[0] || { granted: 0, locked_value_inr: 0, highest_number: null };
    const slotsRemaining = await subscription.founderSlotsRemaining();

    res.json({
      data: {
        mrr_inr: mrr.mrr_inr,
        arr_inr: mrr.mrr_inr * 12,
        arpu_inr: mrr.arpu_inr,
        paying_studios: mrr.paying_studios,
        states: states.rows[0],
        plan_distribution: planMix.rows,
        trial_conversion: {
          started: conv.trials_started,
          converted: conv.trials_converted,
          rate_pct: conv.trials_started > 0
            ? Math.round((conv.trials_converted / conv.trials_started) * 1000) / 10
            : null,
        },
        founders: {
          granted: f.granted,
          limit: subscription.FOUNDER_LIMIT,
          slots_remaining: slotsRemaining,
          locked_value_inr: f.locked_value_inr,
          highest_number: f.highest_number,
        },
        revenue_trend: revenueTrend.rows,
        growth: growth.rows,
      },
    });
  } catch (err) { next(err); }
});

// GET /organizations/:id/subscription — one studio's billing detail + history.
router.get('/organizations/:id/subscription', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query(`
      SELECT o.*, p.name AS plan_name, p.duration_months, p.price_inr
        FROM organizations o LEFT JOIN subscription_plans p ON p.code = o.plan_code
       WHERE o.id = $1`, [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    const o = orgs[0];
    const access = subscription.computeAccess({
      status: o.status, subscription_status: o.subscription_status,
      trial_ends_at: o.trial_ends_at, current_period_end: o.current_period_end,
    });
    const [{ rows: payments }, { rows: invoices }, { rows: events }] = await Promise.all([
      pool.query(`SELECT id, plan_code, amount_inr, method, reference, status, period_start, period_end, recorded_by_name, refunded_at, notes, created_at
                    FROM subscription_payments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT id, invoice_number, plan_code, amount_inr, period_start, period_end, status, issued_at
                    FROM subscription_invoices WHERE organization_id=$1 ORDER BY issued_at DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT id, event, data, actor_name, created_at
                    FROM subscription_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]),
    ]);
    res.json({ data: {
      organization: {
        id: o.id, name: o.name, slug: o.slug, status: o.status,
        subscription_status: o.subscription_status, effective_state: access.state, allowed: access.allowed,
        trial_ends_at: o.trial_ends_at, current_period_start: o.current_period_start, current_period_end: o.current_period_end,
        plan_code: o.plan_code, plan_name: o.plan_name, client_limit: o.client_limit,
        is_founder: o.is_founder, founder_number: o.founder_number, locked_price_inr: o.locked_price_inr,
        trial_days_left: access.trialDaysLeft ?? null, period_days_left: access.periodDaysLeft ?? null,
      },
      payments, invoices, events,
    } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/activate — record a payment + activate/renew.
router.post('/organizations/:id/subscription/activate', async (req, res, next) => {
  try {
    const { plan_code, amount_inr, method, reference, notes, period_months, coupon_code } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.activate(req.params.id, plan_code, {
      amount_inr: amount_inr != null ? Number(amount_inr) : undefined,
      method, reference, notes,
      periodMonths: period_months != null ? Number(period_months) : undefined,
      // Redeemed under a row lock inside the activation transaction.
      couponCode: coupon_code || undefined,
      actor: { id: req.user.id, name: req.user.name },
    });
    invalidateUserCache();
    await audit(req, 'subscription_activated', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'ACTIVATION_FAILED', message: err.message } });
    next(err);
  }
});

// GET /organizations/:id/subscription/change-quote?plan_code=  — price a plan
// change for a studio before executing it (proration credit, amount due,
// effective date, over-limit warning). Read-only.
router.get('/organizations/:id/subscription/change-quote', async (req, res, next) => {
  try {
    const planCode = req.query.plan_code;
    if (!planCode) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const quote = await subscription.quotePlanChange(req.params.id, String(planCode));
    res.json({ data: quote });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'QUOTE_FAILED', message: err.message } });
    next(err);
  }
});

// POST /organizations/:id/subscription/change — execute an immediate, prorated
// upgrade (or same-plan renewal) once payment is confirmed. The unused value of
// the current period is credited, the studio is charged the difference, and the
// billing period restarts from now. Downgrades are rejected here by design —
// they must be scheduled so the studio keeps the time it already paid for.
router.post('/organizations/:id/subscription/change', async (req, res, next) => {
  try {
    const { plan_code, amount_inr, method, reference, notes } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.changePlan(req.params.id, plan_code, {
      amount_inr: amount_inr != null ? Number(amount_inr) : undefined,
      method, reference, notes,
      actor: { id: req.user.id, name: req.user.name },
    });
    invalidateUserCache();
    await audit(req, 'subscription_plan_changed', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'CHANGE_FAILED', message: err.message } });
    next(err);
  }
});

// POST /organizations/:id/subscription/schedule-downgrade — queue a downgrade
// for the end of the current period. Nothing changes now.
router.post('/organizations/:id/subscription/schedule-downgrade', async (req, res, next) => {
  try {
    const { plan_code } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.scheduleDowngrade(req.params.id, plan_code, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_downgrade_scheduled', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'SCHEDULE_FAILED', message: err.message } });
    next(err);
  }
});

// DELETE /organizations/:id/subscription/scheduled-change — drop a pending downgrade.
router.delete('/organizations/:id/subscription/scheduled-change', async (req, res, next) => {
  try {
    const result = await subscription.cancelScheduledChange(req.params.id, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_scheduled_change_cancelled', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/freeze
router.post('/organizations/:id/subscription/freeze', async (req, res, next) => {
  try {
    await subscription.freeze(req.params.id, { id: req.user.id, name: req.user.name }, req.body?.reason);
    invalidateUserCache();
    await audit(req, 'subscription_frozen', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'frozen' } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/reactivate — comp un-freeze (no payment).
router.post('/organizations/:id/subscription/reactivate', async (req, res, next) => {
  try {
    await subscription.reactivate(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_reactivated', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'active' } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/cancel
router.post('/organizations/:id/subscription/cancel', async (req, res, next) => {
  try {
    await subscription.cancelSubscription(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_cancelled', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'cancelled' } });
  } catch (err) { next(err); }
});

// PATCH /organizations/:id/subscription/expiry — override trial / period end.
router.patch('/organizations/:id/subscription/expiry', async (req, res, next) => {
  try {
    const { trial_ends_at, current_period_end } = req.body;
    await subscription.changeExpiry(req.params.id, {
      trialEndsAt: trial_ends_at !== undefined ? (trial_ends_at || null) : undefined,
      periodEnd: current_period_end !== undefined ? (current_period_end || null) : undefined,
    }, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_expiry_changed', 'organization', req.params.id, { trial_ends_at, current_period_end });
    res.json({ data: { id: req.params.id } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/founder — manually grant founder status.
router.post('/organizations/:id/subscription/founder', async (req, res, next) => {
  try {
    const result = await subscription.grantFounder(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'founder_granted', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: 'FOUNDER_FAILED', message: err.message } });
    next(err);
  }
});

// POST /subscription-payments/:id/refund
router.post('/subscription-payments/:id/refund', async (req, res, next) => {
  try {
    const pay = await subscription.refundPayment(req.params.id, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_refunded', 'organization', pay.organization_id, { payment_id: req.params.id });
    res.json({ data: { id: req.params.id, status: 'refunded' } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: 'REFUND_FAILED', message: err.message } });
    next(err);
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTION SELF-CHECKOUT — the operator's verification queue
// ════════════════════════════════════════════════════════════════════════════
//
// Studios pay the platform over UPI and submit the bank reference. This is
// where the operator matches that reference against the platform bank account
// and turns it into an active subscription. Approval delegates to
// subscription.activate(), so founder pricing, coupon redemption, invoices and
// period stacking all behave exactly as they do for a manually recorded
// payment — there is no second activation path.

const checkout = require('../../../lib/subscriptionCheckout');

function checkoutActor(req) {
  return { id: req.user.id, name: req.user.name || null, role: req.user.role };
}

function sendCheckoutError(res, err, next) {
  if (err && err.name === 'PaymentError') {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.status) {
    return res.status(err.status).json({ error: { code: 'CHECKOUT_FAILED', message: err.message } });
  }
  return next(err);
}

// GET /platform-payment-settings — the platform's own payee details.
router.get('/platform-payment-settings', async (req, res, next) => {
  try {
    const data = await checkout.getPlatformSettings();
    res.json({ data, configured: Boolean(data), enabled: Boolean(data?.is_enabled) });
  } catch (err) { next(err); }
});

// PUT /platform-payment-settings
router.put('/platform-payment-settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    const saved = await checkout.savePlatformSettings({
      upi_id: String(body.upi_id || '').trim(),
      merchant_name: String(body.merchant_name || '').trim(),
      instructions: body.instructions ? String(body.instructions).trim().slice(0, 500) : null,
      is_enabled: body.is_enabled === true || body.is_enabled === 'true',
      request_ttl_minutes: Number(body.request_ttl_minutes) || 60,
    }, req.user.id);
    await audit(req, 'platform_payment_settings_updated', 'platform', null, {
      upi_id: saved.upi_id, is_enabled: saved.is_enabled,
    });
    res.json({ data: saved });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// GET /subscription-requests — the queue plus its counters.
router.get('/subscription-requests', async (req, res, next) => {
  try {
    const status = ['AWAITING_VERIFICATION', 'AWAITING_PAYMENT', 'APPROVED', 'ALL']
      .includes(req.query.status) ? req.query.status : 'AWAITING_VERIFICATION';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const conds = [];
    const params = [];
    if (status !== 'ALL') { params.push(status); conds.push(`r.status = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      conds.push(`(o.name ILIKE $${params.length} OR r.request_no ILIKE $${params.length} OR r.utr ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const listParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT ${checkout.REQUEST_COLUMNS},
              o.name AS organization_name, o.slug AS organization_slug,
              o.subscription_status, o.current_period_end,
              p.name AS plan_name, p.duration_months
         FROM subscription_payment_requests r
         JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN subscription_plans p ON p.code = r.plan_code
         ${where}
        ORDER BY r.submitted_at ASC NULLS LAST, r.created_at ASC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM subscription_payment_requests r
         JOIN organizations o ON o.id = r.organization_id ${where}`,
      params
    );

    // Counters come from SQL, so "collected" is the real total rather than the
    // total of whatever happens to be on this page.
    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='AWAITING_VERIFICATION')::int              AS awaiting_count,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='AWAITING_VERIFICATION'),0)::int AS awaiting_amount_inr,
         COUNT(*) FILTER (WHERE status='AWAITING_PAYMENT')::int                   AS unpaid_count,
         COUNT(*) FILTER (WHERE status='APPROVED' AND reviewed_at::date = CURRENT_DATE)::int AS approved_today,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='APPROVED' AND reviewed_at::date = CURRENT_DATE),0)::int AS approved_today_amount_inr,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='APPROVED'),0)::int        AS collected_inr
       FROM subscription_payment_requests`
    );

    res.json({
      data: rows, total: countRows[0].total, stats: stats[0],
      reject_reasons: checkout.REJECT_REASONS,
    });
  } catch (err) { next(err); }
});

// POST /subscription-requests/:id/approve — verify and activate.
router.post('/subscription-requests/:id/approve', async (req, res, next) => {
  try {
    const result = await checkout.approve({ requestId: req.params.id, actor: checkoutActor(req) });
    await audit(req, 'subscription_checkout_approved', 'organization',
      result.request.organization_id, {
        request_no: result.request.request_no, utr: result.request.utr,
        amount_inr: result.request.amount_inr, plan_code: result.request.plan_code,
      });

    // Tell the studio's admins their subscription is live.
    try {
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE organization_id=$1 AND role='admin' AND is_active=true`,
        [result.request.organization_id]
      );
      for (const a of admins) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription','Payment approved',$2,'/subscription')`,
          [a.id, `Your ${result.request.plan_code} subscription is active.`]
        );
      }
    } catch { /* best-effort */ }

    res.json({ data: result });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// POST /subscription-requests/:id/reject
router.post('/subscription-requests/:id/reject', async (req, res, next) => {
  try {
    const result = await checkout.reject({
      requestId: req.params.id,
      reason: req.body?.reason,
      note: req.body?.note ? String(req.body.note).trim().slice(0, 500) : null,
      actor: checkoutActor(req),
    });
    await audit(req, 'subscription_checkout_rejected', 'organization',
      result.request.organization_id, { reason: result.reason, note: result.note });

    try {
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE organization_id=$1 AND role='admin' AND is_active=true`,
        [result.request.organization_id]
      );
      for (const a of admins) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription','Payment could not be verified',$2,'/subscription')`,
          [a.id, `${checkout.REJECT_REASONS[result.reason]}${result.note ? ` — ${result.note}` : ''} You can submit a corrected reference.`]
        );
      }
    } catch { /* best-effort */ }

    res.json({ data: result });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BILLING CENTRE
//
//  The platform's side of the money: what it invoiced, to whom, with what tax,
//  and the seller identity that appears on the document.
//
//  Read-and-export only. Nothing here issues, voids or refunds an invoice —
//  those already happen inside lib/subscription.js as a consequence of a
//  payment, which is the only place they can stay consistent with the payment
//  ledger. A Billing Centre that could mint an invoice on its own would be a
//  second source of truth for revenue.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
