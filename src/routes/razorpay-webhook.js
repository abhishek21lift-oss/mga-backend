// src/routes/razorpay-webhook.js
// H-06: Razorpay webhook receiver with HMAC-SHA256 signature verification.
// Mount BEFORE express.json() so the raw body is available for sig check.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');
const logger  = require('../lib/logger');

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

  try {
    if (eventType === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      if (payment?.id) {
        await pool.query(
          `UPDATE payments
              SET gateway_status = 'captured',
                  gateway_payload = $2,
                  updated_at = NOW()
            WHERE gateway_payment_id = $1`,
          [payment.id, JSON.stringify(payment)],
        );
      }
    } else if (eventType === 'payment.failed') {
      const payment = event.payload?.payment?.entity;
      if (payment?.id) {
        await pool.query(
          `UPDATE payments
              SET gateway_status = 'failed',
                  gateway_payload = $2,
                  updated_at = NOW()
            WHERE gateway_payment_id = $1`,
          [payment.id, JSON.stringify(payment)],
        );
      }
    } else if (eventType === 'refund.processed') {
      const refund = event.payload?.refund?.entity;
      if (refund?.payment_id) {
        await pool.query(
          `UPDATE payments
              SET gateway_status = 'refunded',
                  refund_id = $2,
                  updated_at = NOW()
            WHERE gateway_payment_id = $1`,
          [refund.payment_id, refund.id],
        );
      }
    }
    // Unknown event types are acknowledged but ignored
    res.json({ received: true });
  } catch (err) {
    logger.error({ err: err.message, eventType }, 'Razorpay webhook handler error');
    // Return 200 anyway so Razorpay does not retry — DB errors are logged
    res.json({ received: true });
  }
});

module.exports = router;
