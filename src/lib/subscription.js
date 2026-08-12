'use strict';
// Subscription engine for MY PT STUDIO (SaaS billing).
//
// Central, backend-authoritative logic for the studio subscription lifecycle:
//   trial → active → (expired | frozen | cancelled)
// plus the Founder Club (first 50 paying studios keep a lifetime-locked price)
// and the launch offer (Elite launch price while founder slots remain).
//
// `computeAccess` is a PURE function used by the auth layer to decide, on every
// request, whether a studio may use protected features. It works off timestamps
// so trial/period expiry is enforced lazily (no cron needed to freeze). A worker
// flips the stored status + sends reminders, but enforcement never depends on it.

const pool = require('../db/pool');
const logger = require('./logger');
const platformBilling = require('./platformBilling');

// Founder's Club cap. The launch offer (Elite at ₹7,999) stays live only while
// slots remain, so this single number drives both. Env-overridable so the cap
// can be adjusted without a deploy.
const FOUNDER_LIMIT = parseInt(process.env.FOUNDER_LIMIT, 10) || 20;

// Founder's Club is for annual subscribers. A slot carries a price locked for
// the life of the studio, so it cannot be bought with one month of Starter and
// then ridden forever — which is exactly what the grant used to allow: any
// plan qualified while a slot was free, and the catalogue runs 1, 3, 6 and 12
// months.
//
// Compared against the term actually granted (opts.periodMonths when a super
// admin sets one, otherwise the plan's own duration) rather than against the
// plan code, so a 12-month term on any plan qualifies and a shortened Elite
// term does not. >= rather than ===: a longer commitment is not a reason to
// refuse.
const FOUNDER_MIN_TERM_MONTHS = parseInt(process.env.FOUNDER_MIN_TERM_MONTHS, 10) || 12;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 7;
const DAY_MS = 86400000;

// How close two activations of the same plan have to be before the second is
// treated as a repeat of the first rather than an early renewal. Ten minutes
// covers a double-submit, a retried request and an operator recording the same
// payment twice, without touching anything a studio would plausibly do on
// purpose. Env-overridable so it can be tuned without a deploy.
const DUPLICATE_ACTIVATION_WINDOW_MINUTES =
  parseInt(process.env.DUPLICATE_ACTIVATION_WINDOW_MINUTES, 10) || 10;

// Statuses that consume a plan seat. Per the product spec the limit applies to
// ACTIVE clients only — pending, expired, archived and completed clients do not
// count, so archiving a client frees a slot immediately.
const SEAT_CONSUMING_STATUSES = ['active'];

// ── Access decision (pure) ────────────────────────────────────────────────────
// org snapshot: { status, subscription_status, trial_ends_at, current_period_end }
//   status                — organizations.status: super-admin hard on/off switch
//   subscription_status   — trial | active | expired | frozen | cancelled
// Returns { allowed, state, reason?, trialDaysLeft?, periodDaysLeft?, renewalDue? }.
function computeAccess(org) {
  const now = Date.now();
  if (!org) return { allowed: true, state: 'active' };

  // Super-admin hard suspend overrides everything.
  if (org.status === 'suspended') {
    return { allowed: false, state: 'suspended', reason: 'Your account has been suspended. Please contact support.' };
  }

  const sub = org.subscription_status || 'active';
  const trialEnds = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : null;
  const periodEnds = org.current_period_end ? new Date(org.current_period_end).getTime() : null;

  if (sub === 'cancelled') {
    return { allowed: false, state: 'cancelled', reason: 'Your subscription was cancelled. Subscribe again to continue using MY PT STUDIO.' };
  }
  if (sub === 'frozen') {
    return { allowed: false, state: 'frozen', reason: 'Your trial has expired. Please subscribe to continue using MY PT STUDIO.' };
  }
  if (sub === 'expired') {
    return { allowed: false, state: 'expired', reason: 'Your subscription has expired. Please renew to continue using MY PT STUDIO.' };
  }
  if (sub === 'trial') {
    if (trialEnds !== null && trialEnds <= now) {
      return { allowed: false, state: 'trial_expired', reason: 'Your trial has expired. Please subscribe to continue using MY PT STUDIO.' };
    }
    const trialDaysLeft = trialEnds !== null ? Math.max(0, Math.ceil((trialEnds - now) / DAY_MS)) : null;
    return { allowed: true, state: 'trial', trialDaysLeft };
  }
  if (sub === 'active') {
    if (periodEnds !== null && periodEnds <= now) {
      return { allowed: false, state: 'expired', reason: 'Your subscription has expired. Please renew to continue using MY PT STUDIO.' };
    }
    const periodDaysLeft = periodEnds !== null ? Math.max(0, Math.ceil((periodEnds - now) / DAY_MS)) : null;
    const renewalDue = periodDaysLeft !== null && periodDaysLeft <= 7;
    return { allowed: true, state: 'active', periodDaysLeft, renewalDue };
  }
  // Unknown state — fail open (never lock a studio out on a data anomaly).
  return { allowed: true, state: sub };
}

// ── Plan catalogue ─────────────────────────────────────────────────────────────
async function getPlans() {
  const { rows } = await pool.query(
    `SELECT code, name, price_inr, launch_price_inr, duration_months, client_limit, best_for, sort_order
       FROM subscription_plans WHERE is_active = TRUE ORDER BY sort_order`
  );
  return rows;
}

async function getPlan(code) {
  const { rows } = await pool.query(
    `SELECT code, name, price_inr, launch_price_inr, duration_months, client_limit, best_for
       FROM subscription_plans WHERE code = $1`, [code]
  );
  return rows[0] || null;
}

async function founderSlotsRemaining(client = pool) {
  const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM founder_members');
  return Math.max(0, FOUNDER_LIMIT - n);
}

// Effective price for a plan given current founder-slot availability. The launch
// price applies only while founder slots remain (first 50 studios).
function effectivePrice(plan, slotsRemaining) {
  if (slotsRemaining > 0 && plan.launch_price_inr != null) {
    return { amount: plan.launch_price_inr, isLaunch: true };
  }
  return { amount: plan.price_inr, isLaunch: false };
}

// A priced quote for a plan (what a studio would pay to subscribe right now).
async function quote(code) {
  const plan = await getPlan(code);
  if (!plan) return null;
  const slots = await founderSlotsRemaining();
  const { amount, isLaunch } = effectivePrice(plan, slots);
  return {
    ...plan,
    effective_price_inr: amount,
    is_launch: isLaunch,
    // Both conditions, because this is what the pricing page reads: a slot
    // being free does not make a one-month plan a founder purchase, and
    // saying otherwise promises something the activation will not grant.
    founder_eligible: slots > 0 && plan.duration_months >= FOUNDER_MIN_TERM_MONTHS,
    founder_slots_remaining: slots,
  };
}

// ── Coupons ───────────────────────────────────────────────────────────────────
// Discount maths is pure and separated from validation so it can be tested
// without a database. Rounds to whole rupees and can never exceed the gross —
// a coupon reduces a charge, it never creates a credit.
function computeDiscount(coupon, grossInr) {
  const gross = Math.max(0, Math.round(Number(grossInr) || 0));
  if (!coupon || gross <= 0) return 0;

  let discount = coupon.discount_type === 'percent'
    ? Math.round(gross * (Number(coupon.discount_value) / 100))
    : Math.round(Number(coupon.discount_value));

  if (coupon.max_discount_inr != null) discount = Math.min(discount, Number(coupon.max_discount_inr));
  return Math.max(0, Math.min(discount, gross));
}

/**
 * Check a coupon against a studio and an order amount.
 *
 * Read-only — nothing is reserved. Returns { valid, reason, coupon, discount_inr,
 * net_amount_inr }. `reason` is a human-readable rejection the UI can show
 * directly. Fails closed: an unknown code is simply invalid.
 *
 * Pass an open client to run inside an activation transaction (which locks the
 * coupon row first); otherwise it runs on the pool for a preview.
 */
async function validateCoupon(code, { orgId, planCode, amountInr }, client = pool) {
  const normalised = String(code || '').trim().toUpperCase();
  if (!normalised) return { valid: false, reason: 'Enter a coupon code.' };

  const { rows } = await client.query(
    'SELECT * FROM subscription_coupons WHERE code = $1', [normalised]
  );
  const coupon = rows[0];
  if (!coupon) return { valid: false, reason: 'That coupon code is not recognised.' };
  if (!coupon.is_active) return { valid: false, reason: 'This coupon is no longer active.' };

  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    return { valid: false, reason: 'This coupon is not valid yet.' };
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { valid: false, reason: 'This coupon has expired.' };
  }
  if (coupon.applies_to_plans?.length && planCode && !coupon.applies_to_plans.includes(planCode)) {
    return { valid: false, reason: 'This coupon does not apply to the selected plan.' };
  }
  if (coupon.min_amount_inr != null && Number(amountInr) < Number(coupon.min_amount_inr)) {
    return { valid: false, reason: `This coupon needs an order of at least ₹${coupon.min_amount_inr}.` };
  }

  // Redemption limits are counted from the ledger, never from a stored counter,
  // so they stay correct even if a payment is later adjusted.
  const { rows: [counts] } = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE organization_id = $2)::int AS by_org
       FROM subscription_coupon_redemptions WHERE coupon_id = $1`,
    [coupon.id, orgId || null]
  );
  if (coupon.max_redemptions != null && counts.total >= coupon.max_redemptions) {
    return { valid: false, reason: 'This coupon has been fully redeemed.' };
  }
  if (orgId && counts.by_org >= coupon.max_per_org) {
    return { valid: false, reason: 'You have already used this coupon.' };
  }

  const discount = computeDiscount(coupon, amountInr);
  if (discount <= 0) return { valid: false, reason: 'This coupon does not reduce this order.' };

  return {
    valid: true,
    reason: null,
    coupon: {
      id: coupon.id, code: coupon.code, description: coupon.description,
      discount_type: coupon.discount_type, discount_value: coupon.discount_value,
    },
    discount_inr: discount,
    net_amount_inr: Math.max(0, Math.round(Number(amountInr)) - discount),
  };
}

/**
 * Re-validate under a row lock and write the redemption. Must be called inside
 * an open transaction.
 *
 * The lock is the point: validateCoupon on the pool is a preview and two studios
 * can pass it simultaneously on the last remaining use. Taking FOR UPDATE on the
 * coupon row serialises redemption so a max_redemptions of 1 can only ever be
 * claimed once — the same reasoning as the founder-slot table lock.
 */
async function redeemCoupon(client, code, { orgId, planCode, amountInr, paymentId }) {
  const normalised = String(code || '').trim().toUpperCase();
  if (!normalised) return null;

  await client.query('SELECT id FROM subscription_coupons WHERE code = $1 FOR UPDATE', [normalised]);

  const check = await validateCoupon(normalised, { orgId, planCode, amountInr }, client);
  if (!check.valid) {
    throw Object.assign(new Error(check.reason || 'Coupon is not valid'), {
      status: 400, code: 'COUPON_INVALID',
    });
  }

  const gross = Math.max(0, Math.round(Number(amountInr) || 0));
  const net = Math.max(0, gross - check.discount_inr);

  const { rows: [redemption] } = await client.query(
    `INSERT INTO subscription_coupon_redemptions
       (coupon_id, organization_id, payment_id, plan_code, gross_amount_inr, discount_inr, net_amount_inr)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [check.coupon.id, orgId, paymentId || null, planCode || null, gross, check.discount_inr, net]
  );

  return {
    redemption_id: redemption.id,
    code: check.coupon.code,
    discount_inr: check.discount_inr,
    net_amount_inr: net,
  };
}

// ── Billing audit ──────────────────────────────────────────────────────────────
async function logEvent(client, orgId, event, data, actor) {
  try {
    await (client || pool).query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, event, data ? JSON.stringify(data) : null, actor?.id || null, actor?.name || null]
    );
  } catch { /* best-effort audit */ }
}

// ── Client limits ─────────────────────────────────────────────────────────────
// Seat usage vs the studio's plan limit. limit === null means unlimited
// (grandfathered studios and the Elite plan). atLimit is the gate for new-client
// creation; existing clients always stay accessible.
//
// Only ACTIVE clients consume a seat. Pending, expired, archived and completed
// clients are excluded, so archiving a client frees a slot straight away — a
// Starter studio at 5/5 drops to 4/5 the moment one client is archived. This
// previously counted every non-deleted row regardless of status, which silently
// charged studios for name-only 'pending' entries and long-expired clients.
async function clientLimitStatus(orgId, client = pool) {
  if (!orgId) return { limit: null, count: 0, remaining: null, atLimit: false };
  const { rows: [r] } = await client.query(
    `SELECT o.client_limit,
            (SELECT count(*) FROM pt_clients c
               WHERE c.organization_id = o.id
                 AND c.deleted_at IS NULL
                 AND c.status = ANY($2::text[]))::int AS count
       FROM organizations o WHERE o.id = $1`,
    [orgId, SEAT_CONSUMING_STATUSES]
  );
  if (!r) return { limit: null, count: 0, remaining: null, atLimit: false };
  const limit = r.client_limit;
  return {
    limit,
    count: r.count,
    remaining: limit == null ? null : Math.max(0, limit - r.count),
    atLimit: limit != null && r.count >= limit,
  };
}

// ── Trial ────────────────────────────────────────────────────────────────────
// Start (or restart) a studio's free trial. Called at studio creation.
async function startTrial(orgId, days = TRIAL_DAYS, actor = null) {
  await pool.query(
    `UPDATE organizations
        SET subscription_status = 'trial',
            trial_ends_at = now() + ($2 || ' days')::interval,
            current_period_start = NULL,
            current_period_end = NULL,
            cancelled_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [orgId, String(days)]
  );
  await logEvent(pool, orgId, 'trial_started', { days }, actor);
}

// ── Activation / renewal (records a payment and activates the studio) ─────────
// opts: { amount_inr?, method?, reference?, notes?, periodMonths?, actor }
// Founder club: the first 50 studios to activate become permanent Founder
// Members with a lifetime-locked price. Founders keep their locked price on
// renewal. The founder-slot check + assignment is serialized under a table lock
// so the 50th slot can never be double-granted.
async function activate(orgId, planCode, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialises every activation for THIS studio, so two requests for the
    // same org launched a moment apart (a double click on "Record Payment",
    // a network retry) queue up instead of both reading "no duplicate yet"
    // and each inserting a payment. Released automatically at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orgId]);
    await client.query('LOCK TABLE founder_members IN SHARE ROW EXCLUSIVE MODE');

    // A payment reference (UTR, bank note, whatever the operator typed) can
    // only ever record one real transaction. Checked here for a clean error;
    // uq_sub_payments_live_reference is the actual backstop (see migration
    // 140) since this pre-check alone would still race under concurrency —
    // the advisory lock above is what closes that race.
    if (opts.reference) {
      const dupe = await client.query(
        `SELECT invoice_number FROM subscription_invoices si
           JOIN subscription_payments sp ON sp.id = si.payment_id
          WHERE sp.organization_id = $1 AND sp.reference = $2 AND sp.status = 'paid'`,
        [orgId, opts.reference]
      );
      if (dupe.rows[0]) {
        throw Object.assign(
          new Error(`This reference has already been recorded as payment (invoice ${dupe.rows[0].invoice_number}).`),
          { status: 409, code: 'DUPLICATE_REFERENCE' }
        );
      }
    }

    const plan = (await client.query('SELECT * FROM subscription_plans WHERE code = $1', [planCode])).rows[0];
    if (!plan) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    const org = (await client.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (!org) throw Object.assign(new Error('Studio not found'), { status: 404 });

    const slots = await founderSlotsRemaining(client);
    const alreadyFounder = org.is_founder;

    // The term actually being bought, needed before the founder decision.
    const months = opts.periodMonths || plan.duration_months;

    const grantFounder = !alreadyFounder && slots > 0 && months >= FOUNDER_MIN_TERM_MONTHS;

    const { amount: effAmount } = effectivePrice(plan, slots);
    const paidAmount = opts.amount_inr != null ? Number(opts.amount_inr)
      : (alreadyFounder && org.locked_price_inr != null) ? org.locked_price_inr
      : effAmount;

    const now = new Date();
    // Renewals stack on top of any time still remaining, so a studio never
    // loses days by paying early. A prorated upgrade sets resetPeriod, because
    // the remaining time has already been credited back in cash — stacking it
    // as well would hand the studio that time twice.
    const base = (!opts.resetPeriod && org.current_period_end && new Date(org.current_period_end) > now)
      ? new Date(org.current_period_end)
      : now;
    let periodEnd = new Date(base);
    periodEnd.setMonth(periodEnd.getMonth() + Number(months));

    // ── Stacking guard ──────────────────────────────────────────────────
    //
    // Stacking is right for a real early renewal and wrong for a repeat of
    // the same one. Studio #1 paid for twelve months of Elite and ended up
    // with an expiry two years out, because one UPI payment produced two
    // activations and each stacked its own term. The money was refundable;
    // the extra year of access was simply granted.
    //
    // The reference-level defences upstream (the unique index on
    // (organization_id, reference), the pre-check, the per-org advisory
    // lock) stop the case that caused it. They cannot stop the same thing
    // arriving with a different reference, or none at all — a cash or comp
    // activation recorded twice.
    //
    // So: an activation of the SAME plan for the same studio, within a few
    // minutes of one already recorded, does not extend anything. The payment
    // is still written, because money received is a fact worth recording and
    // may need refunding; what it must not do is silently hand over another
    // term. The event log says it happened so an operator can act on it.
    //
    // Deliberately narrow. A genuine second renewal minutes after the first,
    // for the same plan, is not a thing studios do; anything outside the
    // window, or for a different plan, stacks exactly as before.
    let duplicateOf = null;
    if (!opts.resetPeriod && org.current_period_end) {
      const recent = await client.query(
        `SELECT id, created_at
           FROM subscription_payments
          WHERE organization_id = $1
            AND plan_code = $2
            AND status = 'paid'
            AND created_at > now() - ($3 || ' minutes')::interval
          ORDER BY created_at DESC
          LIMIT 1`,
        [orgId, planCode, String(DUPLICATE_ACTIVATION_WINDOW_MINUTES)]
      );
      if (recent.rows[0]) {
        duplicateOf = recent.rows[0].id;
        // Leave the period exactly where the first activation put it.
        periodEnd = new Date(org.current_period_end);
      }
    }

    // A coupon reduces THIS charge only. It is redeemed under a row lock inside
    // this transaction, so the last remaining use cannot be claimed twice.
    let coupon = null;
    if (opts.couponCode) {
      coupon = await redeemCoupon(client, opts.couponCode, {
        orgId, planCode, amountInr: paidAmount,
      });
    }
    const grossAmount = paidAmount;
    const chargedAmount = coupon ? coupon.net_amount_inr : paidAmount;

    let founderNumber = org.founder_number;
    let lockedPrice = org.locked_price_inr;
    if (grantFounder) {
      const n = (await client.query('SELECT COALESCE(MAX(founder_number),0)+1 AS n FROM founder_members')).rows[0].n;
      founderNumber = n;
      // Deliberately the GROSS price, not what was charged after a coupon. The
      // founder benefit is a lifetime-locked PLAN price; letting a one-off promo
      // become someone's permanent rate would leak revenue on every renewal.
      lockedPrice = grossAmount;
      await client.query(
        `INSERT INTO founder_members (organization_id, founder_number, plan_code, locked_price_inr)
         VALUES ($1,$2,$3,$4)`,
        [orgId, n, planCode, lockedPrice]
      );
    }

    await client.query(
      `UPDATE organizations
          SET subscription_status = 'active', plan_code = $2, client_limit = $3,
              current_period_start = $4, current_period_end = $5, cancelled_at = NULL,
              is_founder = (is_founder OR $6), founder_number = $7, locked_price_inr = $8,
              updated_at = now()
        WHERE id = $1`,
      [orgId, planCode, plan.client_limit, now, periodEnd, grantFounder, founderNumber, lockedPrice]
    );

    let pay;
    try {
      pay = (await client.query(
        `INSERT INTO subscription_payments
           (organization_id, plan_code, amount_inr, method, reference, status,
            period_start, period_end, recorded_by, recorded_by_name, notes,
            proration_credit_inr, previous_plan_code, coupon_code, discount_inr)
         VALUES ($1,$2,$3,$4,$5,'paid',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [orgId, planCode, chargedAmount, opts.method || null, opts.reference || null,
         now, periodEnd, opts.actor?.id || null, opts.actor?.name || null, opts.notes || null,
         opts.prorationCreditInr != null ? opts.prorationCreditInr : null,
         opts.previousPlanCode || null,
         coupon?.code || null, coupon?.discount_inr || null]
      )).rows[0];
    } catch (err) {
      // Backstop for the pre-check above: closes the race it cannot, on its
      // own, fully rule out (see uq_sub_payments_live_reference, migration 140).
      if (err.code === '23505' && String(err.constraint || '').includes('live_reference')) {
        throw Object.assign(
          new Error('This reference has already been recorded as payment for this studio.'),
          { status: 409, code: 'DUPLICATE_REFERENCE' }
        );
      }
      throw err;
    }

    // Link the redemption to the payment now that it exists, so the ledger and
    // the charge can be reconciled from either side.
    if (coupon?.redemption_id) {
      await client.query(
        'UPDATE subscription_coupon_redemptions SET payment_id = $1 WHERE id = $2',
        [pay.id, coupon.redemption_id]
      );
    }

    // Tax and both parties' details are frozen onto the invoice here, at issue
    // time, and never recomputed afterwards — see lib/platformBilling.js. Note
    // this changes nothing about what was CHARGED: chargedAmount is still the
    // figure collected, and the new columns only record how it splits.
    const billing = await platformBilling.loadSettings(client);
    const tax = platformBilling.buildInvoiceTax({ settings: billing, org, amountInr: chargedAmount });

    const seq = (await client.query('SELECT count(*)+1 AS n FROM subscription_invoices')).rows[0].n;
    const invoiceNumber = `${billing.invoice_prefix || 'MPT'}-${now.getFullYear()}-${String(seq).padStart(5, '0')}`;
    await client.query(
      `INSERT INTO subscription_invoices
         (organization_id, payment_id, invoice_number, plan_code, amount_inr, period_start, period_end, status,
          taxable_value_inr, gst_percent, cgst_inr, sgst_inr, igst_inr, seller_snapshot, buyer_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10,$11,$12,$13,$14)`,
      [orgId, pay.id, invoiceNumber, planCode, chargedAmount, now, periodEnd,
       tax.taxable_value_inr, tax.gst_percent, tax.cgst_inr, tax.sgst_inr, tax.igst_inr,
       JSON.stringify(tax.seller_snapshot), JSON.stringify(tax.buyer_snapshot)]
    );

    await logEvent(client, orgId, 'activated', {
      plan_code: planCode, amount_inr: chargedAmount, gross_amount_inr: grossAmount,
      coupon_code: coupon?.code || null, discount_inr: coupon?.discount_inr || null,
      period_end: periodEnd,
      // Present only when the stacking guard fired, so "why did this payment
      // not move the renewal date" is answerable from the billing history
      // rather than by reading this file.
      ...(duplicateOf ? { period_unchanged_duplicate_of: duplicateOf } : {}),
    }, opts.actor);

    if (duplicateOf) {
      await logEvent(client, orgId, 'duplicate_activation_no_stack', {
        plan_code: planCode, amount_inr: chargedAmount,
        duplicate_of_payment_id: duplicateOf,
        window_minutes: DUPLICATE_ACTIVATION_WINDOW_MINUTES,
        period_end: periodEnd,
      }, opts.actor);
      logger.warn(
        { orgId, planCode, duplicateOf, periodEnd },
        'subscription: repeat activation within the duplicate window — payment recorded, period NOT extended'
      );
    }
    if (grantFounder) await logEvent(client, orgId, 'founder_granted', { founder_number: founderNumber, locked_price_inr: lockedPrice }, opts.actor);

    await client.query('COMMIT');
    return {
      plan_code: planCode, amount_inr: chargedAmount, gross_amount_inr: grossAmount,
      coupon_code: coupon?.code || null, discount_inr: coupon?.discount_inr || null,
      period_end: periodEnd, invoice_number: invoiceNumber,
      founder_granted: grantFounder, founder_number: founderNumber,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function freeze(orgId, actor, reason) {
  await pool.query(`UPDATE organizations SET subscription_status='frozen', updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'frozen', { reason: reason || 'manual' }, actor);
}

// Comp reactivation (no payment) — un-freeze a studio back to active.
async function reactivate(orgId, actor) {
  await pool.query(`UPDATE organizations SET subscription_status='active', cancelled_at=NULL, updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'reactivated', {}, actor);
}

async function cancelSubscription(orgId, actor) {
  await pool.query(`UPDATE organizations SET subscription_status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'cancelled', {}, actor);
}

// ── Plan changes: upgrade (immediate, prorated) / downgrade (deferred) ────────
//
// Direction is decided by price, not by name: whichever plan costs more per
// month is the "upgrade". Comparing monthly rates rather than sticker price is
// what makes Growth (₹3,999 / 3 mo = ₹1,333/mo) correctly read as an upgrade
// from Starter (₹1,499 / 1 mo), even though its sticker price is higher.
function monthlyRate(plan, priceInr) {
  const months = Number(plan.duration_months) || 1;
  return Number(priceInr) / months;
}

// Unused value left on the current period, in rupees. Time-based: the share of
// the period still unconsumed, multiplied by what the studio actually paid for
// it. Returns 0 when there is nothing to credit (on trial, expired, no period).
function prorationCredit(org, paidForCurrentPeriod, now = new Date()) {
  if (!org?.current_period_start || !org?.current_period_end) return 0;
  const start = new Date(org.current_period_start).getTime();
  const end = new Date(org.current_period_end).getTime();
  const t = now.getTime();
  const span = end - start;
  if (!(span > 0) || t >= end) return 0;
  const unusedFraction = Math.min(1, Math.max(0, (end - Math.max(t, start)) / span));
  return Math.round(Number(paidForCurrentPeriod || 0) * unusedFraction);
}

// What the studio last actually paid for the period it is currently in. Falls
// back to the plan's effective price when no payment row exists (e.g. a comped
// activation), so a credit is still computed sensibly.
async function amountPaidForCurrentPeriod(orgId, org, client = pool) {
  const { rows } = await client.query(
    `SELECT amount_inr FROM subscription_payments
      WHERE organization_id = $1 AND status = 'paid'
      ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  );
  if (rows.length) return Number(rows[0].amount_inr);
  if (org?.locked_price_inr != null) return Number(org.locked_price_inr);
  return 0;
}

/**
 * Price a plan change without applying it — this is what the studio sees before
 * confirming, and what the super admin sees before executing.
 *
 * Upgrades return `amount_due` (new plan price minus the unused credit, floored
 * at 0) and take effect immediately. Downgrades are always ₹0 now and take
 * effect at period end, so the studio keeps the time it already bought.
 */
async function quotePlanChange(orgId, newPlanCode) {
  const org = (await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows[0];
  if (!org) throw Object.assign(new Error('Studio not found'), { status: 404 });
  const newPlan = await getPlan(newPlanCode);
  if (!newPlan) throw Object.assign(new Error('Unknown plan'), { status: 400 });

  const currentPlan = org.plan_code ? await getPlan(org.plan_code) : null;
  const slots = await founderSlotsRemaining();

  // Founders keep their locked price for the life of the account; everyone else
  // pays the current effective (launch-aware) price.
  const { amount: listPrice, isLaunch } = effectivePrice(newPlan, slots);
  const newPrice = (org.is_founder && org.locked_price_inr != null)
    ? Number(org.locked_price_inr)
    : listPrice;

  const paid = await amountPaidForCurrentPeriod(orgId, org);
  const credit = prorationCredit(org, paid);

  // No current plan (trial / expired / never subscribed) → this is a plain
  // activation, not a change: full price, immediate, no credit.
  const isChange = Boolean(currentPlan) && org.subscription_status === 'active';
  const direction = !isChange ? 'activation'
    : newPlan.code === currentPlan.code ? 'renewal'
    : monthlyRate(newPlan, newPrice) > monthlyRate(currentPlan, paid || currentPlan.price_inr) ? 'upgrade'
    : 'downgrade';

  const usage = await clientLimitStatus(orgId);
  // A downgrade that would put the studio over the new plan's seat limit is
  // allowed but must be surfaced — existing clients are never auto-archived.
  const overLimitBy = newPlan.client_limit != null && usage.count > newPlan.client_limit
    ? usage.count - newPlan.client_limit
    : 0;

  const immediate = direction !== 'downgrade';
  const amountDue = direction === 'downgrade' ? 0 : Math.max(0, newPrice - (direction === 'activation' ? 0 : credit));

  return {
    direction,
    immediate,
    current_plan: currentPlan ? { code: currentPlan.code, name: currentPlan.name, client_limit: currentPlan.client_limit } : null,
    new_plan: { code: newPlan.code, name: newPlan.name, client_limit: newPlan.client_limit, duration_months: newPlan.duration_months },
    new_plan_price_inr: newPrice,
    proration_credit_inr: direction === 'activation' ? 0 : credit,
    amount_due_inr: amountDue,
    is_launch_price: isLaunch && !org.is_founder,
    founder_locked: Boolean(org.is_founder && org.locked_price_inr != null),
    effective_at: immediate ? new Date() : (org.current_period_end || null),
    active_clients: usage.count,
    new_client_limit: newPlan.client_limit,
    over_limit_by: overLimitBy,
    warning: overLimitBy > 0
      ? `This plan allows ${newPlan.client_limit} active clients and you currently have ${usage.count}. `
        + `${overLimitBy} client${overLimitBy === 1 ? '' : 's'} will need to be archived before you can add new ones — `
        + 'no existing client is removed or loses access.'
      : null,
  };
}

/**
 * Apply an immediate, prorated plan change (upgrade or same-plan renewal).
 *
 * Delegates to activate() so there is exactly one code path that writes the
 * payment, invoice, founder grant and period maths — this function's job is
 * only to work out the prorated amount and hand it over.
 */
async function changePlan(orgId, newPlanCode, opts = {}) {
  const q = await quotePlanChange(orgId, newPlanCode);
  if (q.direction === 'downgrade') {
    throw Object.assign(
      new Error('Downgrades take effect at the end of the current billing period — use scheduleDowngrade()'),
      { status: 400, code: 'DOWNGRADE_MUST_BE_SCHEDULED' }
    );
  }

  const result = await activate(orgId, newPlanCode, {
    ...opts,
    // The studio pays the difference, not the full sticker price.
    amount_inr: opts.amount_inr != null ? opts.amount_inr : q.amount_due_inr,
    // An upgrade restarts the period from now; activate() would otherwise stack
    // the new term on top of the remaining one, double-counting the time we
    // just credited back.
    resetPeriod: true,
    // Recorded on the payment row inside the same transaction, so the invoice
    // can show list price vs credit vs charged.
    prorationCreditInr: q.proration_credit_inr,
    previousPlanCode: q.current_plan?.code || null,
  });

  await logEvent(pool, orgId, 'plan_changed', {
    from: q.current_plan?.code || null, to: newPlanCode,
    direction: q.direction, credit_inr: q.proration_credit_inr, charged_inr: q.amount_due_inr,
  }, opts.actor);

  return { ...result, ...q };
}

/**
 * Schedule a downgrade for the end of the current billing period. Nothing
 * changes now: the studio keeps its current plan, limit and access until the
 * period rolls over, at which point the worker applies it.
 */
async function scheduleDowngrade(orgId, newPlanCode, actor = null) {
  const q = await quotePlanChange(orgId, newPlanCode);
  if (q.direction !== 'downgrade') {
    throw Object.assign(
      new Error('That plan is not a downgrade — apply it immediately with changePlan()'),
      { status: 400, code: 'NOT_A_DOWNGRADE' }
    );
  }
  const effectiveAt = q.effective_at;
  if (!effectiveAt) {
    throw Object.assign(new Error('Studio has no active billing period to schedule against'), { status: 400 });
  }

  await pool.query(
    `UPDATE organizations
        SET pending_plan_code = $2, pending_plan_effective_at = $3,
            pending_plan_requested_at = now(), updated_at = now()
      WHERE id = $1`,
    [orgId, newPlanCode, effectiveAt]
  );
  await logEvent(pool, orgId, 'downgrade_scheduled', {
    from: q.current_plan?.code || null, to: newPlanCode,
    effective_at: effectiveAt, over_limit_by: q.over_limit_by,
  }, actor);

  return q;
}

/** Cancel a scheduled downgrade before it takes effect. */
async function cancelScheduledChange(orgId, actor = null) {
  const { rowCount } = await pool.query(
    `UPDATE organizations
        SET pending_plan_code = NULL, pending_plan_effective_at = NULL,
            pending_plan_requested_at = NULL, updated_at = now()
      WHERE id = $1 AND pending_plan_code IS NOT NULL`,
    [orgId]
  );
  if (rowCount) await logEvent(pool, orgId, 'downgrade_cancelled', {}, actor);
  return { cancelled: rowCount > 0 };
}

/**
 * Apply every scheduled downgrade that has come due. Called by the subscription
 * worker. Idempotent — clearing the pending columns means a second run is a
 * no-op, and a studio whose period was extended in the meantime is skipped.
 */
async function applyDueDowngrades(actor = null) {
  const { rows } = await pool.query(
    `SELECT id, pending_plan_code, plan_code
       FROM organizations
      WHERE pending_plan_code IS NOT NULL
        AND pending_plan_effective_at IS NOT NULL
        AND pending_plan_effective_at <= now()`
  );

  const applied = [];
  for (const org of rows) {
    const plan = await getPlan(org.pending_plan_code);
    if (!plan) continue;
    await pool.query(
      `UPDATE organizations
          SET plan_code = $2, client_limit = $3,
              pending_plan_code = NULL, pending_plan_effective_at = NULL,
              pending_plan_requested_at = NULL, updated_at = now()
        WHERE id = $1`,
      [org.id, plan.code, plan.client_limit]
    );
    await logEvent(pool, org.id, 'downgrade_applied', { from: org.plan_code, to: plan.code }, actor);
    applied.push({ organization_id: org.id, from: org.plan_code, to: plan.code });
  }
  return applied;
}

// Change the trial or subscription expiry directly (admin override / comps).
async function changeExpiry(orgId, { trialEndsAt, periodEnd }, actor) {
  const sets = [];
  const params = [orgId];
  if (trialEndsAt !== undefined) { params.push(trialEndsAt); sets.push(`trial_ends_at = $${params.length}`); }
  if (periodEnd !== undefined) { params.push(periodEnd); sets.push(`current_period_end = $${params.length}`); }
  if (!sets.length) return;
  sets.push('updated_at = now()');
  await pool.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
  await logEvent(pool, orgId, 'expiry_changed', { trialEndsAt, periodEnd }, actor);
}

// Manually grant founder status (outside the automatic first-50 flow).
async function grantFounder(orgId, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE founder_members IN SHARE ROW EXCLUSIVE MODE');
    const org = (await client.query('SELECT is_founder, locked_price_inr, plan_code FROM organizations WHERE id=$1', [orgId])).rows[0];
    if (!org) throw Object.assign(new Error('Studio not found'), { status: 404 });
    if (org.is_founder) { await client.query('COMMIT'); return { already: true }; }
    const n = (await client.query('SELECT COALESCE(MAX(founder_number),0)+1 AS n FROM founder_members')).rows[0].n;
    const locked = org.locked_price_inr || 0;
    await client.query(
      `INSERT INTO founder_members (organization_id, founder_number, plan_code, locked_price_inr) VALUES ($1,$2,$3,$4)`,
      [orgId, n, org.plan_code || null, locked]
    );
    await client.query(
      `UPDATE organizations SET is_founder=TRUE, founder_number=$2, updated_at=now() WHERE id=$1`,
      [orgId, n]
    );
    await logEvent(client, orgId, 'founder_granted', { founder_number: n, manual: true }, actor);
    await client.query('COMMIT');
    return { founder_number: n };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refundPayment(paymentId, actor) {
  const pay = (await pool.query(
    `UPDATE subscription_payments SET status='refunded', refunded_at=now()
      WHERE id=$1 AND status='paid' RETURNING organization_id, amount_inr`, [paymentId]
  )).rows[0];
  if (!pay) throw Object.assign(new Error('Payment not found or already refunded'), { status: 404 });
  await pool.query(`UPDATE subscription_invoices SET status='refunded' WHERE payment_id=$1`, [paymentId]);
  await logEvent(pool, pay.organization_id, 'refunded', { payment_id: paymentId, amount_inr: pay.amount_inr }, actor);
  return pay;
}

module.exports = {
  FOUNDER_LIMIT,
  TRIAL_DAYS,
  computeAccess,
  getPlans,
  getPlan,
  founderSlotsRemaining,
  effectivePrice,
  quote,
  logEvent,
  startTrial,
  clientLimitStatus,
  activate,
  freeze,
  reactivate,
  cancelSubscription,
  changeExpiry,
  grantFounder,
  refundPayment,
  // Coupons
  computeDiscount,
  validateCoupon,
  redeemCoupon,
  // Plan changes (upgrade / downgrade)
  quotePlanChange,
  changePlan,
  scheduleDowngrade,
  cancelScheduledChange,
  applyDueDowngrades,
  prorationCredit,
};
