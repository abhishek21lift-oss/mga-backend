// src/lib/upiPayments.js
//
// Manual UTR verification payments — the domain layer.
//
// Everything that decides *what is true* about a UPI payment lives here:
// the status machine, the money arithmetic, the UPI intent construction and
// the transactional approval engine. The route module (routes/upi-payments.js)
// only does HTTP: parse, authorise, call in here, serialise.
//
// Two rules this module exists to enforce:
//
//   1. A status transition is only ever attempted as a conditional UPDATE
//      (`WHERE status = <expected>`). If the row has moved on, the UPDATE
//      matches zero rows and the caller gets a 409 instead of silently
//      overwriting someone else's decision. Two admins clicking Approve at
//      the same moment is the case this is for, and it is not hypothetical
//      on a shared studio login.
//
//   2. An approval either does everything or nothing. Activating the
//      membership, writing the finance-ledger row, stamping the receipt and
//      recording the audit trail happen in one transaction, because a
//      half-applied approval is a member who paid and has no membership.

'use strict';

const { randomUUID } = require('crypto');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { genReceiptNo } = require('../db/receipts');
const logger = require('./logger');

// ── Status vocabulary ───────────────────────────────────────────────────────
const ORDER_STATUS = Object.freeze({
  CREATED: 'CREATED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  VERIFICATION_PENDING: 'VERIFICATION_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

const SUBMISSION_STATUS = Object.freeze({
  VERIFICATION_PENDING: 'VERIFICATION_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

// Statuses an order can still be paid against. Used by the expiry sweep and
// by every "can this order accept a UTR" check, so the two can never drift.
const OPEN_ORDER_STATUSES = Object.freeze([ORDER_STATUS.CREATED, ORDER_STATUS.PAYMENT_PENDING]);

const REJECT_REASONS = Object.freeze({
  DUPLICATE_UTR: 'This UTR has already been submitted.',
  WRONG_UTR: 'The reference number does not match any payment we received.',
  PAYMENT_NOT_RECEIVED: 'No payment was received against this order.',
  AMOUNT_MISMATCH: 'The amount received does not match the order total.',
  FAKE_SCREENSHOT: 'The payment proof could not be verified.',
  OTHER: 'See the note from the studio.',
});

// ── Errors ──────────────────────────────────────────────────────────────────
// A small typed error so routes can map domain failures onto status codes
// without string-matching messages.
class PaymentError extends Error {
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ── Money ───────────────────────────────────────────────────────────────────
//
// Rupees are held as a 2-decimal NUMERIC everywhere in this schema. JS numbers
// are binary floats, so the only safe way to move between them is to round at
// every boundary — 18% of 2999 is 539.8199999999999 in IEEE-754, and that
// value stored and re-read produces a receipt that does not add up.
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Split a base price into GST and total.
 * GST is treated as EXCLUSIVE (added on top), which is what the payment page
 * shows: base, then GST, then total.
 */
function computeTotals(baseAmount, gstPercent) {
  const base = round2(baseAmount);
  const pct = Number(gstPercent) || 0;
  if (!Number.isFinite(base) || base < 0) {
    throw new PaymentError('INVALID_AMOUNT', 'Base amount must be a non-negative number');
  }
  const gst = round2((base * pct) / 100);
  const total = round2(base + gst);
  if (total <= 0) {
    throw new PaymentError('INVALID_AMOUNT', 'Order total must be greater than zero');
  }
  return { base_amount: base, gst_percent: pct, gst_amount: gst, total_amount: total };
}

// ── UPI intent construction ─────────────────────────────────────────────────

const VPA_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/;

function assertVpa(upiId) {
  if (!VPA_RE.test(String(upiId || ''))) {
    throw new PaymentError('INVALID_VPA', 'UPI ID must look like name@bank', 400);
  }
}

/**
 * NPCI's `tr` (transaction reference) field is alphanumeric and capped at 35
 * characters. Our order numbers carry hyphens for readability, and several
 * PSP apps quietly drop the whole intent when they meet one, so the reference
 * is stripped down before it goes on the wire. The readable form still
 * travels in `tn` (the note) and on the receipt.
 */
function toTxnRef(orderNo) {
  return String(orderNo || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 35);
}

/**
 * The note shown inside the UPI app. Capped at 50 characters and stripped of
 * the characters that terminate a query string, because a stray & or # turns
 * a valid intent into a silently-failing one.
 */
function toTxnNote(text) {
  return String(text || '')
    .replace(/[^\w\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

/**
 * Build the canonical `upi://pay` deep link.
 *
 * This is the one that actually works everywhere: on Android it opens the
 * system UPI app chooser, and it is what the QR encodes. The per-app schemes
 * below are a convenience layer on top of it, not a replacement.
 */
function buildUpiIntent({ upiId, merchantName, amount, orderNo, note }) {
  assertVpa(upiId);
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new PaymentError('INVALID_AMOUNT', 'Amount must be greater than zero');
  }
  const params = new URLSearchParams({
    pa: String(upiId),
    pn: toTxnNote(merchantName) || 'Studio',
    am: amt.toFixed(2),
    cu: 'INR',
    tr: toTxnRef(orderNo),
    tn: toTxnNote(note || `Membership ${orderNo}`),
  });
  return `upi://pay?${params.toString()}`;
}

/**
 * Per-app deep links.
 *
 * Deliberately honest about what these are: PSP apps register their own URL
 * schemes and carry the same query string as `upi://pay`, but the schemes are
 * undocumented, differ between Android and iOS builds, and break without
 * notice. The UI therefore treats every one of these as best-effort and always
 * offers the universal link and the QR as the fallback — a member must never
 * be stuck because one vendor renamed a scheme.
 */
const UPI_APPS = Object.freeze([
  { key: 'gpay', label: 'Google Pay', scheme: 'tez://upi/pay' },
  { key: 'phonepe', label: 'PhonePe', scheme: 'phonepe://pay' },
  { key: 'paytm', label: 'Paytm', scheme: 'paytmmp://pay' },
  { key: 'amazonpay', label: 'Amazon Pay', scheme: 'amazonToAlipay://pay' },
  { key: 'bhim', label: 'BHIM', scheme: 'bhim://pay' },
]);

function buildAppIntents(intentUrl) {
  const query = intentUrl.slice(intentUrl.indexOf('?'));
  return UPI_APPS.map((app) => ({ key: app.key, label: app.label, url: `${app.scheme}${query}` }));
}

/**
 * QR payload as a PNG data URI.
 *
 * Rendered server-side so the payment page needs no QR dependency and, more
 * importantly, so the encoded VPA and amount come from the database rather
 * than from anything the browser could have tampered with.
 */
async function generateQrDataUrl(intentUrl) {
  return QRCode.toDataURL(intentUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0B1220', light: '#FFFFFF' },
  });
}

// ── Dates ───────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * pt_clients.pt_end_date is a TEXT column dating back to migration 017 and can
 * legitimately hold an empty string, a null, or — on old imported rows —
 * something that is not a date at all. Anything that does not parse cleanly is
 * treated as "no existing membership" rather than being cast in SQL, where a
 * bad value would abort the whole approval transaction.
 */
function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) return null;
  const d = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : value.trim();
}

function addMonthsIso(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  // Day 0 of the following month is the last day of the target month, which
  // is how 31 Jan + 1 month lands on 28/29 Feb instead of overflowing into
  // March the way a naive setMonth() does.
  const lastDayOfTarget = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTarget);
  const end = new Date(Date.UTC(y, m - 1 + months, day));
  return end.toISOString().slice(0, 10);
}

/**
 * Work out the window an approved payment buys.
 *
 * A renewal paid before the current membership lapses must EXTEND it, not
 * restart it from today — otherwise paying early costs the member the days
 * they had left, which is the fastest way to make people stop renewing early.
 */
function computeMembershipWindow(existingEndDate, durationMonths, today = todayIso()) {
  const existing = parseIsoDate(existingEndDate);
  const from = existing && existing > today ? existing : today;
  return { activated_from: from, activated_to: addMonthsIso(from, durationMonths) };
}

// ── Settings ────────────────────────────────────────────────────────────────

/** Column list shared by every settings read, so the shape never drifts. */
const SETTINGS_COLUMNS = `
  id, organization_id, upi_id, merchant_name, gst_percent, gst_number,
  is_enabled, instructions, order_ttl_minutes, created_at, updated_at`;

async function getSettings(orgId, client = pool) {
  const { rows } = await client.query(
    `SELECT ${SETTINGS_COLUMNS} FROM payment_settings WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

/**
 * Settings a payment can actually be taken against.
 *
 * Fails closed and loudly: a studio that has not configured its VPA, or has
 * switched collection off, must not be able to show a member a QR code that
 * sends money nowhere.
 */
async function requireActiveSettings(orgId, client = pool) {
  const settings = await getSettings(orgId, client);
  if (!settings) {
    throw new PaymentError(
      'PAYMENTS_NOT_CONFIGURED',
      'Online payments are not set up for this studio yet.',
      409
    );
  }
  if (!settings.is_enabled) {
    throw new PaymentError(
      'PAYMENTS_DISABLED',
      'Online payments are currently switched off for this studio.',
      409
    );
  }
  assertVpa(settings.upi_id);
  return settings;
}

async function upsertSettings(orgId, input, client = pool) {
  assertVpa(input.upi_id);
  const { rows } = await client.query(
    `INSERT INTO payment_settings
       (organization_id, upi_id, merchant_name, gst_percent, gst_number,
        is_enabled, instructions, order_ttl_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (organization_id) DO UPDATE SET
       upi_id            = EXCLUDED.upi_id,
       merchant_name     = EXCLUDED.merchant_name,
       gst_percent       = EXCLUDED.gst_percent,
       gst_number        = EXCLUDED.gst_number,
       is_enabled        = EXCLUDED.is_enabled,
       instructions      = EXCLUDED.instructions,
       order_ttl_minutes = EXCLUDED.order_ttl_minutes
     RETURNING ${SETTINGS_COLUMNS}`,
    [
      orgId,
      input.upi_id,
      input.merchant_name,
      input.gst_percent ?? 0,
      input.gst_number ?? null,
      input.is_enabled ?? false,
      input.instructions ?? null,
      input.order_ttl_minutes ?? 60,
    ]
  );
  return rows[0];
}

// ── Audit ───────────────────────────────────────────────────────────────────

/**
 * Append to the payment audit trail.
 *
 * Takes an explicit client so it can join the caller's transaction: an
 * approval and its audit row must commit or roll back together, or the trail
 * ends up asserting things that never happened.
 */
async function audit(client, { orgId, orderId, submissionId, action, from, to, detail, actor }) {
  await client.query(
    `INSERT INTO payment_audit_logs
       (organization_id, payment_order_id, submission_id, action, from_status, to_status,
        detail, actor_id, actor_name, actor_role, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      orgId,
      orderId || null,
      submissionId || null,
      action,
      from || null,
      to || null,
      detail ? JSON.stringify(detail) : null,
      actor?.id || null,
      actor?.name || null,
      actor?.role || null,
      actor?.ip || null,
      actor?.userAgent || null,
    ]
  );
}

// ── Order numbers ───────────────────────────────────────────────────────────

async function nextOrderNo(client) {
  const { rows } = await client.query(`SELECT nextval('payment_order_no_seq') AS n`);
  const d = new Date();
  const stamp =
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  return `UPI-${stamp}-${String(rows[0].n).padStart(6, '0')}`;
}

// ── Orders ──────────────────────────────────────────────────────────────────

const ORDER_COLUMNS = `
  o.id, o.organization_id, o.order_no, o.client_id, o.plan_id, o.plan_name,
  o.duration_months, o.base_amount, o.gst_percent, o.gst_amount, o.total_amount,
  o.upi_id, o.merchant_name, o.status, o.expires_at, o.notes,
  o.created_by, o.created_at, o.updated_at`;

/**
 * Create an order, or hand back the one that is already open.
 *
 * The "already open" branch is not an optimisation. A member who taps Pay,
 * backgrounds the app, and taps Pay again would otherwise end up with two live
 * orders for the same membership and two ways to activate it. The partial
 * unique index in migration 112 makes the second insert impossible; this reads
 * the existing row first so the common case is a clean 200 rather than a
 * caught constraint violation.
 */
async function createOrder({ orgId, client: memberRow, plan, actor }, db = pool) {
  const settings = await requireActiveSettings(orgId, db);
  const totals = computeTotals(plan.base_amount, settings.gst_percent);

  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows: existing } = await tx.query(
      `SELECT ${ORDER_COLUMNS} FROM payment_orders o
        WHERE o.organization_id = $1 AND o.client_id = $2
          AND COALESCE(o.plan_id, '') = COALESCE($3, '') AND o.plan_name = $4
          AND o.status = ANY($5::text[])
        LIMIT 1`,
      [orgId, memberRow.id, plan.plan_id || null, plan.plan_name,
       [...OPEN_ORDER_STATUSES, ORDER_STATUS.VERIFICATION_PENDING]]
    );

    if (existing[0]) {
      await audit(tx, {
        orgId, orderId: existing[0].id, action: 'ORDER_REUSED',
        from: existing[0].status, to: existing[0].status,
        detail: { reason: 'An order for this membership was already open' }, actor,
      });
      await tx.query('COMMIT');
      return { order: existing[0], reused: true };
    }

    const orderNo = await nextOrderNo(tx);
    const { rows } = await tx.query(
      `INSERT INTO payment_orders
         (id, organization_id, order_no, client_id, plan_id, plan_name, duration_months,
          base_amount, gst_percent, gst_amount, total_amount, upi_id, merchant_name,
          status, expires_at, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               NOW() + ($15 || ' minutes')::interval, $16, $17)
       RETURNING ${ORDER_COLUMNS.replace(/o\./g, '')}`,
      [
        randomUUID(), orgId, orderNo, memberRow.id, plan.plan_id || null, plan.plan_name,
        plan.duration_months, totals.base_amount, totals.gst_percent, totals.gst_amount,
        totals.total_amount, settings.upi_id, settings.merchant_name,
        ORDER_STATUS.CREATED, String(settings.order_ttl_minutes), plan.notes || null,
        actor?.id || null,
      ]
    );

    await audit(tx, {
      orgId, orderId: rows[0].id, action: 'ORDER_CREATED',
      from: null, to: ORDER_STATUS.CREATED,
      detail: { order_no: orderNo, total_amount: totals.total_amount, plan: plan.plan_name },
      actor,
    });

    await tx.query('COMMIT');
    return { order: rows[0], reused: false };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * Everything the payment page needs, assembled from the stored order rather
 * than from anything the client sent: the intent URL, the per-app links and
 * the QR are all derived from the VPA and amount recorded at creation time.
 */
async function buildPaymentView(order) {
  const intentUrl = buildUpiIntent({
    upiId: order.upi_id,
    merchantName: order.merchant_name,
    amount: order.total_amount,
    orderNo: order.order_no,
    note: `${order.plan_name} ${order.order_no}`,
  });
  return {
    intent_url: intentUrl,
    app_intents: buildAppIntents(intentUrl),
    qr_data_url: await generateQrDataUrl(intentUrl),
  };
}

/** Mark that the member actually opened a UPI app. Best-effort telemetry. */
async function markIntentOpened(order, actor, db = pool) {
  if (order.status !== ORDER_STATUS.CREATED) return order;
  const { rows } = await db.query(
    `UPDATE payment_orders SET status = $1 WHERE id = $2 AND status = $3
     RETURNING ${ORDER_COLUMNS.replace(/o\./g, '')}`,
    [ORDER_STATUS.PAYMENT_PENDING, order.id, ORDER_STATUS.CREATED]
  );
  if (!rows[0]) return order;
  await audit(db, {
    orgId: order.organization_id, orderId: order.id, action: 'INTENT_OPENED',
    from: ORDER_STATUS.CREATED, to: ORDER_STATUS.PAYMENT_PENDING, actor,
  });
  return rows[0];
}

// ── Submission ──────────────────────────────────────────────────────────────

/**
 * Attach a UTR to an order.
 *
 * The order transition is conditional on it still being open, so a UTR cannot
 * be attached to an order that has already been approved, cancelled or swept
 * as expired. The duplicate-UTR check is left to the partial unique index —
 * a pre-flight SELECT would still race, so the constraint violation is caught
 * and translated instead of pretending to have prevented it.
 */
async function submitUtr({ order, utr, screenshot, notes, actor }, db = pool) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows: locked } = await tx.query(
      `SELECT ${ORDER_COLUMNS} FROM payment_orders o WHERE o.id = $1 FOR UPDATE`,
      [order.id]
    );
    const current = locked[0];
    if (!current) throw new PaymentError('NOT_FOUND', 'Order not found', 404);

    if (!OPEN_ORDER_STATUSES.includes(current.status)) {
      throw new PaymentError(
        'ORDER_NOT_OPEN',
        `This order is ${current.status.toLowerCase().replace(/_/g, ' ')} and cannot accept a payment reference.`,
        409,
        { status: current.status }
      );
    }
    if (new Date(current.expires_at).getTime() < Date.now()) {
      throw new PaymentError('ORDER_EXPIRED', 'This payment link has expired. Start a new one.', 409);
    }

    let submission;
    try {
      const { rows } = await tx.query(
        `INSERT INTO payment_submissions
           (id, organization_id, payment_order_id, utr, screenshot_url, screenshot_mime,
            screenshot_bytes, notes, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          randomUUID(), current.organization_id, current.id, utr,
          screenshot?.url || null, screenshot?.mime || null, screenshot?.bytes || null,
          notes || null, SUBMISSION_STATUS.VERIFICATION_PENDING, actor?.id || null,
        ]
      );
      submission = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // 23505 = unique_violation. Which index fired decides the message.
        if (String(err.constraint || '').includes('live_utr')) {
          throw new PaymentError(
            'DUPLICATE_UTR',
            'That reference number has already been submitted. Check the number and try again.',
            409
          );
        }
        throw new PaymentError(
          'ALREADY_SUBMITTED',
          'A payment reference for this order is already awaiting verification.',
          409
        );
      }
      throw err;
    }

    await tx.query(
      `UPDATE payment_orders SET status = $1 WHERE id = $2 AND status = ANY($3::text[])`,
      [ORDER_STATUS.VERIFICATION_PENDING, current.id, OPEN_ORDER_STATUSES]
    );

    await audit(tx, {
      orgId: current.organization_id, orderId: current.id, submissionId: submission.id,
      action: 'UTR_SUBMITTED', from: current.status, to: ORDER_STATUS.VERIFICATION_PENDING,
      detail: { utr, has_screenshot: Boolean(screenshot?.url) }, actor,
    });

    await tx.query('COMMIT');
    return submission;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ── Approval ────────────────────────────────────────────────────────────────

/**
 * Approve a submission and activate the membership.
 *
 * One transaction, in this order:
 *   1. lock the order and the client row
 *   2. flip order + submission to APPROVED, conditionally
 *   3. extend the membership window on pt_clients
 *   4. write the finance-ledger row (pt_payments) so UPI revenue appears in
 *      the same reports as cash — this is why the revenue dashboard and the
 *      monthly target pick it up without any special-casing
 *   5. stamp membership_payments with the receipt number
 *   6. audit
 *
 * Step 2 is what makes a double-approve safe: the UPDATE carries
 * `WHERE status = 'VERIFICATION_PENDING'`, so the second caller updates zero
 * rows and gets a 409. The UNIQUE constraint on membership_payments
 * (payment_order_id) is the belt to that braces — if the two somehow
 * interleave, the second insert cannot land.
 */
async function approve({ orderId, orgId, actor }, db = pool) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows: orderRows } = await tx.query(
      `SELECT ${ORDER_COLUMNS} FROM payment_orders o
        WHERE o.id = $1 AND o.organization_id = $2 FOR UPDATE`,
      [orderId, orgId]
    );
    const order = orderRows[0];
    if (!order) throw new PaymentError('NOT_FOUND', 'Payment not found', 404);

    if (order.status !== ORDER_STATUS.VERIFICATION_PENDING) {
      throw new PaymentError(
        'NOT_PENDING_VERIFICATION',
        `This payment is already ${order.status.toLowerCase().replace(/_/g, ' ')}.`,
        409,
        { status: order.status }
      );
    }

    const { rows: subRows } = await tx.query(
      `SELECT * FROM payment_submissions
        WHERE payment_order_id = $1 AND status = $2
        ORDER BY submitted_at DESC LIMIT 1 FOR UPDATE`,
      [order.id, SUBMISSION_STATUS.VERIFICATION_PENDING]
    );
    const submission = subRows[0];
    if (!submission) {
      throw new PaymentError('NO_SUBMISSION', 'There is no pending payment reference to approve.', 409);
    }

    // ── 2. Conditional transitions ──
    const { rowCount: orderMoved } = await tx.query(
      `UPDATE payment_orders SET status = $1 WHERE id = $2 AND status = $3`,
      [ORDER_STATUS.APPROVED, order.id, ORDER_STATUS.VERIFICATION_PENDING]
    );
    if (orderMoved !== 1) {
      throw new PaymentError('CONCURRENT_UPDATE', 'This payment was just updated by someone else.', 409);
    }
    await tx.query(
      `UPDATE payment_submissions
          SET status = $1, verified_by = $2, verified_at = NOW()
        WHERE id = $3 AND status = $4`,
      [SUBMISSION_STATUS.APPROVED, actor?.id || null, submission.id,
       SUBMISSION_STATUS.VERIFICATION_PENDING]
    );

    // ── 3. Membership window ──
    const { rows: clientRows } = await tx.query(
      `SELECT id, name, email, mobile, trainer_id, pt_end_date, organization_id
         FROM pt_clients WHERE id = $1 FOR UPDATE`,
      [order.client_id]
    );
    const member = clientRows[0];
    if (!member) throw new PaymentError('NOT_FOUND', 'Member not found', 404);

    const window = computeMembershipWindow(member.pt_end_date, order.duration_months);

    await tx.query(
      `UPDATE pt_clients
          SET pt_start_date  = COALESCE(NULLIF(pt_start_date, ''), $1),
              pt_end_date    = $2,
              paid_amount    = paid_amount + $3,
              balance_amount = GREATEST(0, balance_amount - $3),
              status         = 'active',
              updated_at     = NOW()
        WHERE id = $4`,
      [window.activated_from, window.activated_to, order.total_amount, member.id]
    );

    // ── 4. Finance ledger ──
    // Trainer commission mirrors routes/payments.js: the FK target is verified
    // first, because a client pointing at a deleted trainer would otherwise
    // abort the whole approval with a foreign-key violation.
    let trainerId = null;
    let incentiveRate = 0.5;
    if (member.trainer_id) {
      const { rows: tr } = await tx.query(
        'SELECT id, incentive_rate FROM trainers WHERE id = $1', [member.trainer_id]
      );
      if (tr[0]) {
        trainerId = tr[0].id;
        incentiveRate = tr[0].incentive_rate ?? 0.5;
      }
    }

    const receiptNo = await genReceiptNo(tx);
    const ptPaymentId = randomUUID();
    await tx.query(
      `INSERT INTO pt_payments
         (id, client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref,
          date, notes, organization_id)
       VALUES ($1,$2,$3,$4,$5,'UPI',$6,$7,$8,$9)`,
      [
        ptPaymentId, member.id, trainerId, order.total_amount,
        Math.round(Number(order.total_amount) * incentiveRate), receiptNo,
        todayIso(), `UPI ${order.order_no} · UTR ${submission.utr}`, orgId,
      ]
    );

    // ── 5. Invoice ──
    // Written into the existing `invoices` table so an approved UPI payment
    // appears on /finance/invoices beside every other sale, rather than living
    // only inside this module.
    //
    // The invoice number is derived from the order number rather than from
    // Date.now() (which is what routes/invoices.js does): order_no already
    // comes off a sequence and is UNIQUE per organization, so this cannot
    // collide under concurrency the way a millisecond timestamp can.
    //
    // Status is 'paid' at birth — by the time an admin approves, the money is
    // confirmed in the bank. A 'draft' invoice here would be a lie.
    //
    // SAVEPOINT, not a bare try/catch: in Postgres ANY failed statement aborts
    // the whole transaction, so catching the error without a savepoint would
    // leave every following statement failing with "current transaction is
    // aborted" — the approval would die anyway, just more confusingly.
    const invoiceNo = `INV-${order.order_no.replace(/^UPI-/, '')}`;
    let invoiceId = null;
    await tx.query('SAVEPOINT upi_invoice');
    try {
      invoiceId = randomUUID();
      await tx.query(
        `INSERT INTO invoices
           (id, invoice_no, client_id, client_name, amount, tax_amount, total_amount,
            status, issue_date, payment_method, notes, created_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,'UPI',$9,$10,$11)`,
        [
          invoiceId, invoiceNo, member.id, member.name,
          order.base_amount, order.gst_amount, order.total_amount,
          todayIso(), `${order.plan_name} · UTR ${submission.utr}`,
          actor?.id || null, orgId,
        ]
      );
      await tx.query('RELEASE SAVEPOINT upi_invoice');
    } catch (err) {
      // An invoice is a convenience document. If the table is missing on an
      // older install, or the insert is rejected, the PAYMENT must still be
      // approved and the membership still activated — the member has paid.
      // Rolling back the whole approval here would strand them.
      await tx.query('ROLLBACK TO SAVEPOINT upi_invoice');
      invoiceId = null;
      logger.warn(
        { err: err.message, orderId: order.id },
        'upi: invoice row could not be written; approval continues'
      );
    }

    // ── 6. Activation record ──
    let activation;
    try {
      const { rows } = await tx.query(
        `INSERT INTO membership_payments
           (id, organization_id, payment_order_id, submission_id, client_id, pt_payment_id,
            receipt_no, amount, utr, activated_from, activated_to, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          randomUUID(), orgId, order.id, submission.id, member.id, ptPaymentId,
          receiptNo, order.total_amount, submission.utr,
          window.activated_from, window.activated_to, actor?.id || null,
        ]
      );
      activation = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new PaymentError('ALREADY_ACTIVATED', 'This payment has already been approved.', 409);
      }
      throw err;
    }

    // ── 7. Audit ──
    await audit(tx, {
      orgId, orderId: order.id, submissionId: submission.id, action: 'APPROVED',
      from: ORDER_STATUS.VERIFICATION_PENDING, to: ORDER_STATUS.APPROVED,
      detail: {
        utr: submission.utr, amount: order.total_amount,
        receipt_no: receiptNo, invoice_no: invoiceId ? invoiceNo : null,
      }, actor,
    });
    await audit(tx, {
      orgId, orderId: order.id, submissionId: submission.id, action: 'MEMBERSHIP_ACTIVATED',
      detail: { from: window.activated_from, to: window.activated_to, plan: order.plan_name }, actor,
    });

    await tx.query('COMMIT');
    return {
      order: { ...order, status: ORDER_STATUS.APPROVED },
      submission, activation, member,
      invoice: invoiceId ? { id: invoiceId, invoice_no: invoiceNo } : null,
    };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ── Rejection ───────────────────────────────────────────────────────────────

/**
 * Reject a submission.
 *
 * The ORDER goes back to PAYMENT_PENDING rather than to REJECTED, because the
 * member is explicitly allowed to resubmit — the money may genuinely have
 * moved and the reference simply been mistyped. Only the SUBMISSION carries
 * the rejection. `requestCorrection` is the same transition with a softer
 * message, which is why they share this function.
 */
async function reject({ orderId, orgId, reason, note, actor, correction = false }, db = pool) {
  if (!Object.prototype.hasOwnProperty.call(REJECT_REASONS, reason)) {
    throw new PaymentError('INVALID_REASON', 'Unknown rejection reason', 400);
  }
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');

    const { rows: orderRows } = await tx.query(
      `SELECT ${ORDER_COLUMNS} FROM payment_orders o
        WHERE o.id = $1 AND o.organization_id = $2 FOR UPDATE`,
      [orderId, orgId]
    );
    const order = orderRows[0];
    if (!order) throw new PaymentError('NOT_FOUND', 'Payment not found', 404);
    if (order.status !== ORDER_STATUS.VERIFICATION_PENDING) {
      throw new PaymentError(
        'NOT_PENDING_VERIFICATION',
        `This payment is already ${order.status.toLowerCase().replace(/_/g, ' ')}.`,
        409,
        { status: order.status }
      );
    }

    const { rowCount } = await tx.query(
      `UPDATE payment_submissions
          SET status = $1, rejected_reason = $2, rejected_note = $3,
              verified_by = $4, verified_at = NOW()
        WHERE payment_order_id = $5 AND status = $6`,
      [SUBMISSION_STATUS.REJECTED, reason, note || null, actor?.id || null,
       order.id, SUBMISSION_STATUS.VERIFICATION_PENDING]
    );
    if (rowCount !== 1) {
      throw new PaymentError('NO_SUBMISSION', 'There is no pending payment reference to reject.', 409);
    }

    // Back to open so the member can try again before the order expires. The
    // TTL is refreshed for the same reason — an order rejected an hour after
    // submission would otherwise be dead on arrival.
    await tx.query(
      `UPDATE payment_orders
          SET status = $1,
              expires_at = GREATEST(expires_at, NOW() + interval '60 minutes')
        WHERE id = $2 AND status = $3`,
      [ORDER_STATUS.PAYMENT_PENDING, order.id, ORDER_STATUS.VERIFICATION_PENDING]
    );

    await audit(tx, {
      orgId, orderId: order.id, action: correction ? 'CORRECTION_REQUESTED' : 'REJECTED',
      from: ORDER_STATUS.VERIFICATION_PENDING, to: ORDER_STATUS.PAYMENT_PENDING,
      detail: { reason, note: note || null }, actor,
    });

    await tx.query('COMMIT');
    return { order: { ...order, status: ORDER_STATUS.PAYMENT_PENDING }, reason, note: note || null };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ── Cancellation ────────────────────────────────────────────────────────────

async function cancel({ orderId, orgId, actor }, db = pool) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const { rows } = await tx.query(
      `UPDATE payment_orders SET status = $1
        WHERE id = $2 AND organization_id = $3 AND status = ANY($4::text[])
        RETURNING ${ORDER_COLUMNS.replace(/o\./g, '')}`,
      [ORDER_STATUS.CANCELLED, orderId, orgId,
       [...OPEN_ORDER_STATUSES, ORDER_STATUS.VERIFICATION_PENDING]]
    );
    if (!rows[0]) {
      throw new PaymentError(
        'NOT_CANCELLABLE',
        'This payment can no longer be cancelled.',
        409
      );
    }
    await tx.query(
      `UPDATE payment_submissions SET status = $1
        WHERE payment_order_id = $2 AND status = $3`,
      [SUBMISSION_STATUS.CANCELLED, orderId, SUBMISSION_STATUS.VERIFICATION_PENDING]
    );
    await audit(tx, {
      orgId, orderId, action: 'CANCELLED', to: ORDER_STATUS.CANCELLED, actor,
    });
    await tx.query('COMMIT');
    return rows[0];
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ── Expiry sweep ────────────────────────────────────────────────────────────

/**
 * Close orders nobody ever paid.
 *
 * Only touches CREATED and PAYMENT_PENDING. An order sitting in
 * VERIFICATION_PENDING is waiting on the STUDIO, not the member, and expiring
 * it would punish the member for the admin's backlog.
 */
async function expireStaleOrders(db = pool) {
  const { rows } = await db.query(
    `UPDATE payment_orders SET status = $1
      WHERE status = ANY($2::text[]) AND expires_at < NOW()
      RETURNING id, organization_id, status`,
    [ORDER_STATUS.EXPIRED, OPEN_ORDER_STATUSES]
  );
  for (const row of rows) {
    try {
      await audit(db, {
        orgId: row.organization_id, orderId: row.id, action: 'EXPIRED',
        to: ORDER_STATUS.EXPIRED, detail: { swept_at: new Date().toISOString() },
      });
    } catch (err) {
      logger.warn({ err: err.message, orderId: row.id }, 'upi: audit of expiry failed');
    }
  }
  return rows.length;
}

module.exports = {
  ORDER_STATUS,
  SUBMISSION_STATUS,
  OPEN_ORDER_STATUSES,
  REJECT_REASONS,
  UPI_APPS,
  PaymentError,
  ORDER_COLUMNS,
  round2,
  computeTotals,
  assertVpa,
  toTxnRef,
  toTxnNote,
  buildUpiIntent,
  buildAppIntents,
  generateQrDataUrl,
  buildPaymentView,
  parseIsoDate,
  addMonthsIso,
  computeMembershipWindow,
  getSettings,
  requireActiveSettings,
  upsertSettings,
  audit,
  nextOrderNo,
  createOrder,
  markIntentOpened,
  submitUtr,
  approve,
  reject,
  cancel,
  expireStaleOrders,
};
