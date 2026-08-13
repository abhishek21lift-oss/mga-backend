// src/routes/razorpay-webhook.js
// H-06: Razorpay webhook receiver with HMAC-SHA256 signature verification.
// Mount BEFORE express.json() so the raw body is available for sig check.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');
const logger  = require('../lib/logger');

const PROVIDER = 'razorpay';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

// Raw-body middleware for this route only — must come before json parsing.
router.use(express.raw({ type: 'application/json', limit: '50kb' }));

router.post('/', async (req, res) => {
  if (!WEBHOOK_SECRET) {
    logger.error('RAZORPAY_WEBHOOK_SECRET is not set — webhook rejected');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing signature header' });
  }

  // H-06: timing-safe HMAC comparison
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn({ signature }, 'Razorpay webhook signature mismatch');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const eventType = event?.event;
  logger.info({ eventType }, 'Razorpay webhook received');

  // ── Provider identifiers only ────────────────────────────────────────
  //
  // Nothing tenant-shaped is read from this message. gateway_record_event
  // (migration 164) resolves the organisation from the gateway_transactions
  // row that a trusted, authenticated path created when the charge was
  // initiated, and it has no organization_id parameter — so a forged one in
  // the payload has nowhere to go.
  //
  // This replaces three UPDATEs against `payments` that could never have
  // worked: they matched on gateway_payment_id, while the only writer —
  // renewal.worker.js — records gateway_txn_id. Different columns, and both
  // absent from the schema anyway.
  const entity = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;

  const MAPPING = {
    'payment.captured': () => ({ paymentId: entity?.id, status: 'captured', payload: entity }),
    'payment.failed':   () => ({ paymentId: entity?.id, status: 'failed',   payload: entity }),
    'refund.processed': () => ({ paymentId: refund?.payment_id, status: 'refunded',
                                 payload: refund, refundId: refund?.id }),
  };

  const mapped = MAPPING[eventType]?.();

  // Razorpay sends many event types this application has no domain effect
  // for. Acknowledging them is safe precisely because nothing was meant to
  // change; a 5xx would only ask the provider to resend something we will
  // ignore again.
  if (!mapped) return res.json({ received: true, applied: false, reason: 'unhandled_event' });

  // A handled event with no payment id is malformed. 4xx, not 5xx: resending
  // the same broken payload cannot help.
  if (!mapped.paymentId) return res.status(400).json({ error: 'Event carries no payment id' });

  try {
    const { rows } = await pool.query(
      `SELECT transaction_id, organization_id, applied
         FROM gateway_record_event($1,$2,$3,$4,$5,$6)`,
      [PROVIDER, mapped.paymentId, event.id || null, mapped.status,
       JSON.stringify(mapped.payload || {}), mapped.refundId || null],
    );
    const result = rows[0] || {};

    if (!result.transaction_id) {
      // No local transaction for this provider id. Fail closed — inventing a
      // row would mean inventing a tenant to own it. 200 because this is a
      // permanent condition: retrying will not conjure the transaction.
      logger.warn({ eventType }, 'razorpay event for an unknown provider payment id');
      return res.json({ received: true, applied: false, reason: 'unknown_payment' });
    }

    // applied === false means this exact event id was already recorded. 200 is
    // both correct and necessary: the state the provider wanted is durable, and
    // it should stop resending.
    logger.info({ eventType, applied: result.applied }, 'razorpay gateway event recorded');
    return res.json({ received: true, applied: result.applied });
  } catch (err) {
    logger.error({ err: err.message, eventType }, 'Razorpay webhook handler error');
    // 500, not 200.
    //
    // This used to acknowledge the event regardless, on the reasoning that a
    // database error is ours and a retry would not help. The effect was that
    // the handler told Razorpay "processed" for events it had not processed,
    // and the provider — correctly trusting that — never sent them again. A
    // failed write became permanent silent data loss with a log line as its
    // only trace.
    //
    // It was not theoretical: this route used to write columns `payments`
    // does not have, so every event raised 42703 and was acknowledged anyway.
    // Persistence now goes through gateway_record_event (migration 164), so
    // this branch is back to meaning what it should — a genuine, probably
    // transient, database fault.
    //
    // A 5xx makes Razorpay retry, which is right for a transient fault and
    // makes a permanent one loud instead of invisible. Signature and payload
    // rejections keep their 4xx and are still never retried — those are the
    // caller's fault, not ours.
    res.status(500).json({ received: false });
  }
});

module.exports = router;
