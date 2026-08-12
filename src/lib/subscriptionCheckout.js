// src/lib/subscriptionCheckout.js
//
// A studio paying the PLATFORM for its subscription, over UPI, verified by
// hand in the command centre.
//
// ── How this differs from lib/upiPayments.js ────────────────────────────────
// That module is a studio collecting from its own members. This one is the
// platform collecting from its studios. Same mechanism, opposite direction:
//
//                        upiPayments.js          this module
//   payer                gym member              studio admin
//   payee                the studio's VPA        the platform's VPA
//   approver             studio admin            platform super admin
//   activates            a gym membership        the studio's subscription
//
// The UPI primitives (intent construction, QR, VPA validation, rupee
// rounding) are IMPORTED from there rather than copied — there must be exactly
// one implementation of "how do we build a upi://pay link", or the two drift
// and one of them silently stops opening in PhonePe.
//
// ── What this module refuses to own ─────────────────────────────────────────
// Activation. On approval it calls subscription.activate(), which already
// knows about founder pricing, coupon redemption under a row lock, period
// stacking, invoices and the billing event log. Reimplementing any of that
// here would give the platform two answers to "when does this studio expire".

'use strict';

const pool = require('../db/pool');
const logger = require('./logger');
const subscription = require('./subscription');
const {
  PaymentError, assertVpa, buildUpiIntent, buildAppIntents, generateQrDataUrl,
} = require('./upiPayments');

// ── Status vocabulary ───────────────────────────────────────────────────────
const REQUEST_STATUS = Object.freeze({
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  AWAITING_VERIFICATION: 'AWAITING_VERIFICATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

/** Statuses where the studio still has something to do. */
const OPEN_STATUSES = Object.freeze([
  REQUEST_STATUS.AWAITING_PAYMENT,
  REQUEST_STATUS.AWAITING_VERIFICATION,
]);

const REJECT_REASONS = Object.freeze({
  DUPLICATE_UTR: 'This reference has already been used for another payment.',
  WRONG_UTR: 'The reference number does not match any payment we received.',
  PAYMENT_NOT_RECEIVED: 'No payment was received against this request.',
  AMOUNT_MISMATCH: 'The amount received does not match the plan price.',
  FAKE_SCREENSHOT: 'The payment proof could not be verified.',
  OTHER: 'See the note from the platform team.',
});

const REQUEST_COLUMNS = `
  r.id, r.organization_id, r.request_no, r.plan_code,
  r.list_price_inr, r.discount_inr, r.amount_inr, r.coupon_code,
  r.direction, r.proration_credit_inr, r.previous_plan_code,
  r.upi_id, r.merchant_name, r.status, r.expires_at,
  r.utr, r.screenshot_url, r.payer_note, r.submitted_at,
  r.reviewed_at, r.rejected_reason, r.rejected_note, r.payment_id,
  r.created_at, r.updated_at`;

/** Same list without the `r.` prefix, for INSERT ... RETURNING. */
const REQUEST_COLUMNS_BARE = REQUEST_COLUMNS.replace(/r\./g, '');

// ── Platform payee settings ─────────────────────────────────────────────────

const SETTINGS_COLUMNS = `
  upi_id, merchant_name, instructions, is_enabled,
  request_ttl_minutes, created_at, updated_at`;

async function getPlatformSettings(client = pool) {
  const { rows } = await client.query(
    `SELECT ${SETTINGS_COLUMNS} FROM platform_payment_settings WHERE singleton = TRUE`
  );
  return rows[0] || null;
}

/**
 * Settings a studio can actually be charged against.
 *
 * Fails closed. A studio must never be shown a QR before the operator has
 * entered a real VPA and switched collection on.
 */
async function requirePlatformSettings(client = pool) {
  const s = await getPlatformSettings(client);
  if (!s) {
    throw new PaymentError(
      'PLATFORM_PAYMENTS_NOT_CONFIGURED',
      'Online payment is not set up yet. Please contact the MY PT STUDIO team.',
      409
    );
  }
  if (!s.is_enabled) {
    throw new PaymentError(
      'PLATFORM_PAYMENTS_DISABLED',
      'Online payment is temporarily unavailable. Please contact the MY PT STUDIO team.',
      409
    );
  }
  assertVpa(s.upi_id);
  return s;
}

async function savePlatformSettings(input, actorId, client = pool) {
  assertVpa(input.upi_id);
  const { rows } = await client.query(
    `INSERT INTO platform_payment_settings
       (singleton, upi_id, merchant_name, instructions, is_enabled, request_ttl_minutes, updated_by)
     VALUES (TRUE,$1,$2,$3,$4,$5,$6)
     ON CONFLICT (singleton) DO UPDATE SET
       upi_id              = EXCLUDED.upi_id,
       merchant_name       = EXCLUDED.merchant_name,
       instructions        = EXCLUDED.instructions,
       is_enabled          = EXCLUDED.is_enabled,
       request_ttl_minutes = EXCLUDED.request_ttl_minutes,
       updated_by          = EXCLUDED.updated_by
     RETURNING ${SETTINGS_COLUMNS}`,
    [
      input.upi_id, input.merchant_name, input.instructions ?? null,
      input.is_enabled ?? false, input.request_ttl_minutes ?? 60, actorId || null,
    ]
  );
  return rows[0];
}

// ── Pricing ─────────────────────────────────────────────────────────────────

/**
 * What this studio should be charged for this plan, right now.
 *
 * Delegates the base figure to subscription.quotePlanChange() — the SAME
 * function the priced preview and the operator's manual execute path use —
 * rather than pricing a plain activation independently. That function already
 * knows: a brand-new subscription pays the full (founder/launch-aware) price;
 * an already-active studio switching or renewing gets that price MINUS
 * whatever credit is left on its current period. Two pricing engines for "what
 * does this studio owe" is how one of them quietly drifts from the other.
 *
 * A coupon is PREVIEWED here only — it is redeemed for real inside
 * subscription.activate(), under a row lock, at approval time. So a code that
 * gets exhausted between checkout and approval is caught there rather than
 * being silently honoured.
 */
async function priceFor(orgId, planCode, couponCode, client = pool) {
  const q = await subscription.quotePlanChange(orgId, planCode);

  if (q.direction === 'downgrade') {
    // Downgrades are free and take effect at period end — there is nothing to
    // collect, so there is nothing to check out. The tenant UI schedules
    // these through requestChange()/scheduleDowngrade() instead; a client
    // reaching this path for a downgrade is a stale quote, not a real intent.
    throw new PaymentError(
      'DOWNGRADE_NOT_PAYABLE',
      'Downgrades take effect at the end of your billing period and cost nothing to schedule.',
      400
    );
  }

  const baseAmount = q.amount_due_inr;

  let discount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    try {
      const v = await subscription.validateCoupon(
        couponCode, { orgId, planCode, amountInr: baseAmount }, client
      );
      if (v && v.valid) {
        discount = Number(v.discount_inr) || 0;
        appliedCoupon = String(couponCode).trim().toUpperCase();
      }
    } catch (err) {
      // An invalid coupon must not block checkout — the studio just pays full
      // price and can retry with a corrected code.
      logger.warn({ err: err.message, orgId, couponCode }, 'checkout: coupon preview failed');
    }
  }

  if (discount > baseAmount) discount = baseAmount;
  const amount = baseAmount - discount;
  if (amount <= 0) {
    // A zero-rupee UPI intent is rejected by every app, so a fully-credited
    // renewal or a 100%-off coupon cannot go down this path — the operator
    // activates those directly.
    throw new PaymentError(
      'NOTHING_TO_PAY',
      'This plan costs nothing right now. Contact the team to activate it directly.',
      409
    );
  }

  return {
    plan: q.new_plan,
    list_price_inr: baseAmount,
    discount_inr: discount,
    amount_inr: amount,
    coupon_code: appliedCoupon,
    direction: q.direction,
    proration_credit_inr: q.proration_credit_inr,
    previous_plan_code: q.current_plan?.code || null,
  };
}

// ── Request numbers ─────────────────────────────────────────────────────────

async function nextRequestNo(client) {
  const { rows } = await client.query(`SELECT nextval('subscription_request_no_seq') AS n`);
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `SUB-${stamp}-${String(rows[0].n).padStart(5, '0')}`;
}

// ── Checkout ────────────────────────────────────────────────────────────────

/**
 * Open a checkout, or hand back the one already open.
 *
 * Reuse is not an optimisation. A studio admin who taps Pay, backgrounds the
 * tab and taps again would otherwise put two identical requests in the
 * operator's queue and could pay twice. The partial unique index makes a
 * second row impossible; this reads first so the common case is a clean 200.
 *
 * If the open request is for a DIFFERENT plan than the one now being bought,
 * it is cancelled and replaced — the studio changed its mind, and holding them
 * to a stale price would be worse than reissuing.
 */
async function openCheckout({ orgId, planCode, couponCode, actor }, db = pool) {
  const settings = await requirePlatformSettings(db);
  const pricing = await priceFor(orgId, planCode, couponCode, db);

  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows: existing } = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM subscription_payment_requests r
        WHERE r.organization_id = $1 AND r.status = ANY($2::text[])
        FOR UPDATE`,
      [orgId, OPEN_STATUSES]
    );
    const open = existing[0];

    if (open && open.plan_code === planCode) {
      await tx.query('COMMIT');
      return { request: open, reused: true };
    }
    if (open) {
      // Different plan — retire the old one so the unique index frees up.
      await tx.query(
        `UPDATE subscription_payment_requests SET status = $1 WHERE id = $2`,
        [REQUEST_STATUS.CANCELLED, open.id]
      );
    }

    const requestNo = await nextRequestNo(tx);
    const { rows } = await tx.query(
      `INSERT INTO subscription_payment_requests
         (organization_id, request_no, plan_code, list_price_inr, discount_inr,
          amount_inr, coupon_code, direction, proration_credit_inr, previous_plan_code,
          upi_id, merchant_name, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               NOW() + ($14 || ' minutes')::interval, $15)
       RETURNING ${REQUEST_COLUMNS_BARE}`,
      [
        orgId, requestNo, planCode,
        pricing.list_price_inr, pricing.discount_inr, pricing.amount_inr, pricing.coupon_code,
        pricing.direction, pricing.proration_credit_inr, pricing.previous_plan_code,
        settings.upi_id, settings.merchant_name,
        REQUEST_STATUS.AWAITING_PAYMENT, String(settings.request_ttl_minutes),
        actor?.id || null,
      ]
    );

    await subscription.logEvent(tx, orgId, 'checkout_opened', {
      request_no: requestNo, plan_code: planCode, amount_inr: pricing.amount_inr,
    }, actor);

    await tx.query('COMMIT');
    return { request: rows[0], reused: false };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * The QR and app links for a request.
 *
 * Built from the STORED vpa and amount, so what the camera reads cannot have
 * been altered in the browser. Rebuilt on every read rather than cached, so a
 * page left open overnight cannot present a stale figure.
 */
async function buildCheckoutView(request) {
  const intentUrl = buildUpiIntent({
    upiId: request.upi_id,
    merchantName: request.merchant_name,
    amount: request.amount_inr,
    orderNo: request.request_no,
    note: `MY PT STUDIO ${request.plan_code} ${request.request_no}`,
  });
  return {
    intent_url: intentUrl,
    app_intents: buildAppIntents(intentUrl),
    qr_data_url: await generateQrDataUrl(intentUrl),
  };
}

// ── Submitting the reference ────────────────────────────────────────────────

/**
 * Attach a UTR and send the request to the operator's queue.
 *
 * The transition is conditional on the request still awaiting payment, so a
 * reference cannot be attached to something already approved, cancelled or
 * swept. Duplicate detection is left to the platform-wide partial unique
 * index — a pre-flight SELECT would still race, so the violation is caught and
 * translated rather than pretended away.
 */
async function submitUtr({ requestId, orgId, utr, screenshotUrl, note, actor }, db = pool) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows } = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM subscription_payment_requests r
        WHERE r.id = $1 AND r.organization_id = $2 FOR UPDATE`,
      [requestId, orgId]
    );
    const request = rows[0];
    if (!request) throw new PaymentError('NOT_FOUND', 'Payment request not found', 404);

    if (request.status !== REQUEST_STATUS.AWAITING_PAYMENT) {
      throw new PaymentError(
        'NOT_AWAITING_PAYMENT',
        `This request is ${request.status.toLowerCase().replace(/_/g, ' ')}.`,
        409, { status: request.status }
      );
    }
    if (new Date(request.expires_at).getTime() < Date.now()) {
      throw new PaymentError('REQUEST_EXPIRED', 'This payment link has expired. Start again.', 409);
    }

    let updated;
    try {
      const res = await tx.query(
        `UPDATE subscription_payment_requests
            SET status = $1, utr = $2, screenshot_url = $3, payer_note = $4,
                submitted_by = $5, submitted_at = NOW(),
                -- Clear the previous rejection: this is a fresh claim, and
                -- leaving the old note would show the studio "rejected" text
                -- while it waits on a reference the operator has not seen yet.
                rejected_note = NULL, reviewed_by = NULL, reviewed_at = NULL
          WHERE id = $6 AND status = $7
          RETURNING ${REQUEST_COLUMNS_BARE}`,
        [
          REQUEST_STATUS.AWAITING_VERIFICATION, utr, screenshotUrl || null, note || null,
          actor?.id || null, request.id, REQUEST_STATUS.AWAITING_PAYMENT,
        ]
      );
      updated = res.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // Platform-wide uniqueness: this UTR is already claimed, possibly by a
        // different studio. That is exactly the case worth surfacing.
        throw new PaymentError(
          'DUPLICATE_UTR',
          'That reference number has already been submitted. Check the number and try again.',
          409
        );
      }
      throw err;
    }
    if (!updated) {
      throw new PaymentError('CONCURRENT_UPDATE', 'This request was just updated elsewhere.', 409);
    }

    await subscription.logEvent(tx, orgId, 'checkout_utr_submitted', {
      request_no: request.request_no, utr, amount_inr: request.amount_inr,
    }, actor);

    await tx.query('COMMIT');
    return updated;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ── Operator decisions ──────────────────────────────────────────────────────

/**
 * Approve a request and activate the studio's subscription.
 *
 * The status flip is conditional (`WHERE status = 'AWAITING_VERIFICATION'`),
 * so two operators clicking Approve at the same moment cannot both proceed —
 * the second updates zero rows and gets a 409 rather than activating twice.
 *
 * Activation itself is delegated to subscription.activate(), which runs its
 * own transaction covering founder grants, coupon redemption under a lock, the
 * payment row and the invoice. That means the flip and the activation are NOT
 * one atomic unit — so the flip happens first and is treated as the claim on
 * the work. If activation then fails, the request is put back for retry rather
 * than left marked approved with nothing activated.
 *
 * For an upgrade or renewal (request.direction !== 'activation'), the proration
 * credit and previous plan frozen at checkout time are passed through exactly
 * as subscription.changePlan() would — resetPeriod:true, since that credit was
 * already paid out in cash by charging a smaller amount, so stacking the new
 * term on top of the remaining one would hand the studio that time twice.
 */
async function approve({ requestId, actor }, db = pool) {
  const { rows } = await db.query(
    `SELECT ${REQUEST_COLUMNS}, o.name AS organization_name
       FROM subscription_payment_requests r
       JOIN organizations o ON o.id = r.organization_id
      WHERE r.id = $1`,
    [requestId]
  );
  const request = rows[0];
  if (!request) throw new PaymentError('NOT_FOUND', 'Payment request not found', 404);
  if (request.status !== REQUEST_STATUS.AWAITING_VERIFICATION) {
    throw new PaymentError(
      'NOT_AWAITING_VERIFICATION',
      `This request is already ${request.status.toLowerCase().replace(/_/g, ' ')}.`,
      409, { status: request.status }
    );
  }

  const { rowCount } = await db.query(
    `UPDATE subscription_payment_requests
        SET status = $1, reviewed_by = $2, reviewed_at = NOW()
      WHERE id = $3 AND status = $4`,
    [REQUEST_STATUS.APPROVED, actor?.id || null, requestId, REQUEST_STATUS.AWAITING_VERIFICATION]
  );
  if (rowCount !== 1) {
    throw new PaymentError('CONCURRENT_UPDATE', 'This request was just reviewed by someone else.', 409);
  }

  // An upgrade/renewal was priced against the studio's REMAINING period
  // (proration credit already netted out of amount_inr) — the same shape
  // subscription.changePlan() produces for an operator-executed change. A
  // brand-new activation has no previous period to credit, so these stay at
  // their defaults.
  const isChange = request.direction !== 'activation';

  let result;
  try {
    result = await subscription.activate(request.organization_id, request.plan_code, {
      amount_inr: request.amount_inr,
      method: 'upi',
      reference: request.utr,
      notes: `Self-checkout ${request.request_no}`,
      // camelCase: that is the key subscription.activate() actually reads
      // (opts.couponCode). Passing coupon_code would have silently skipped
      // redemption and charged the studio the discounted amount while leaving
      // the coupon unspent.
      couponCode: request.coupon_code || undefined,
      actor,
      ...(isChange ? {
        resetPeriod: true,
        prorationCreditInr: request.proration_credit_inr,
        previousPlanCode: request.previous_plan_code,
      } : {}),
    });
    if (isChange) {
      await subscription.logEvent(db, request.organization_id, 'plan_changed', {
        from: request.previous_plan_code, to: request.plan_code,
        direction: request.direction, credit_inr: request.proration_credit_inr,
        charged_inr: request.amount_inr, via: 'self_checkout',
      }, actor).catch(() => {});
    }
  } catch (err) {
    // Put it back so the operator can retry, rather than leaving a request
    // marked approved against a subscription that never activated.
    await db.query(
      `UPDATE subscription_payment_requests
          SET status = $1, reviewed_by = NULL, reviewed_at = NULL
        WHERE id = $2 AND status = $3`,
      [REQUEST_STATUS.AWAITING_VERIFICATION, requestId, REQUEST_STATUS.APPROVED]
    ).catch(() => {});
    logger.error(
      { err: err.message, requestId, orgId: request.organization_id },
      'checkout: activation failed after approval — request returned to the queue'
    );
    throw err;
  }

  // Link the request to the payment row activation wrote. activate() returns
  // the invoice number but not the payment id, so it is looked up by the
  // reference it was stamped with — the UTR, which is unique platform-wide.
  try {
    const { rows: pay } = await db.query(
      `SELECT id FROM subscription_payments
        WHERE organization_id = $1 AND reference = $2
        ORDER BY created_at DESC LIMIT 1`,
      [request.organization_id, request.utr]
    );
    if (pay[0]) {
      await db.query(
        'UPDATE subscription_payment_requests SET payment_id = $1 WHERE id = $2',
        [pay[0].id, requestId]
      );
    }
  } catch (err) {
    // Cosmetic link only — the subscription is already active and the payment
    // recorded, so this must never turn a successful approval into a failure.
    logger.warn({ err: err.message, requestId }, 'checkout: could not link payment row');
  }

  return { request: { ...request, status: REQUEST_STATUS.APPROVED }, activation: result };
}

/**
 * Reject a claim.
 *
 * The request is NOT closed — it returns to AWAITING_PAYMENT so the studio can
 * correct the reference and resubmit. The money may genuinely have moved and
 * the number simply been mistyped; closing it would force a fresh checkout at
 * a price that may have changed.
 */
async function reject({ requestId, reason, note, actor }, db = pool) {
  if (!Object.prototype.hasOwnProperty.call(REJECT_REASONS, reason)) {
    throw new PaymentError('INVALID_REASON', 'Unknown rejection reason', 400);
  }
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const { rows } = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM subscription_payment_requests r
        WHERE r.id = $1 FOR UPDATE`,
      [requestId]
    );
    const request = rows[0];
    if (!request) throw new PaymentError('NOT_FOUND', 'Payment request not found', 404);
    if (request.status !== REQUEST_STATUS.AWAITING_VERIFICATION) {
      throw new PaymentError(
        'NOT_AWAITING_VERIFICATION',
        `This request is already ${request.status.toLowerCase().replace(/_/g, ' ')}.`,
        409
      );
    }

    // The row cannot keep `rejected_reason` — the CHECK constraint ties that
    // column to status='REJECTED', and this request is going back to payable.
    // So the reason is folded into the note the studio actually reads. Without
    // this the studio would be sent back to the QR with no explanation at all
    // unless the operator happened to type one.
    const explanation = [REJECT_REASONS[reason], note && note.trim()]
      .filter(Boolean).join(' — ');

    // Back to payable, with the UTR cleared so the studio can enter the right
    // one — and with a refreshed window, since a rejection an hour later would
    // otherwise land on an already-expired request.
    const { rows: after } = await tx.query(
      `UPDATE subscription_payment_requests
          SET status = $1, rejected_reason = $2, rejected_note = $3,
              reviewed_by = $4, reviewed_at = NOW(),
              utr = NULL, submitted_at = NULL,
              expires_at = GREATEST(expires_at, NOW() + interval '60 minutes')
        WHERE id = $5 AND status = $6
        RETURNING ${REQUEST_COLUMNS_BARE}`,
      [
        REQUEST_STATUS.AWAITING_PAYMENT, null, explanation || null,
        actor?.id || null, requestId, REQUEST_STATUS.AWAITING_VERIFICATION,
      ]
    );
    if (!after[0]) {
      throw new PaymentError('CONCURRENT_UPDATE', 'This request was just reviewed by someone else.', 409);
    }

    await subscription.logEvent(tx, request.organization_id, 'checkout_rejected', {
      request_no: request.request_no, reason, note: note || null, utr: request.utr,
    }, actor);

    await tx.query('COMMIT');
    return { request: after[0], reason, note: note || null };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** The studio withdraws its own request. */
async function cancel({ requestId, orgId, actor }, db = pool) {
  const { rows } = await db.query(
    `UPDATE subscription_payment_requests SET status = $1
      WHERE id = $2 AND organization_id = $3 AND status = ANY($4::text[])
      RETURNING ${REQUEST_COLUMNS_BARE}`,
    [REQUEST_STATUS.CANCELLED, requestId, orgId, OPEN_STATUSES]
  );
  if (!rows[0]) {
    throw new PaymentError('NOT_CANCELLABLE', 'This request can no longer be cancelled.', 409);
  }
  await subscription.logEvent(db, orgId, 'checkout_cancelled', { request_id: requestId }, actor)
    .catch(() => {});
  return rows[0];
}

// ── Expiry sweep ────────────────────────────────────────────────────────────

/**
 * Close checkouts nobody ever paid.
 *
 * Only touches AWAITING_PAYMENT. A request sitting in AWAITING_VERIFICATION is
 * waiting on the OPERATOR, and expiring it would punish the studio for the
 * platform's own backlog.
 */
async function expireStaleRequests(db = pool) {
  const { rows } = await db.query(
    `UPDATE subscription_payment_requests SET status = $1
      WHERE status = $2 AND expires_at < NOW()
      RETURNING id`,
    [REQUEST_STATUS.EXPIRED, REQUEST_STATUS.AWAITING_PAYMENT]
  );
  return rows.length;
}

module.exports = {
  REQUEST_STATUS,
  OPEN_STATUSES,
  REJECT_REASONS,
  REQUEST_COLUMNS,
  getPlatformSettings,
  requirePlatformSettings,
  savePlatformSettings,
  priceFor,
  nextRequestNo,
  openCheckout,
  buildCheckoutView,
  submitUtr,
  approve,
  reject,
  cancel,
  expireStaleRequests,
};
