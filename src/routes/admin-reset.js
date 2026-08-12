const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');
const logger  = require('../lib/logger');
const { escapeIdentifier } = require('pg');
const { sendAdminResetOtp } = require('../lib/email');

// SECURITY (audit finding C-1): this router performs platform-wide, unscoped
// destructive operations (DELETE/DROP with no organization_id filter, across
// every tenant). It must only ever be reachable by the platform super admin.
// That is enforced at the mount point in server.js: `auth, requireSuperAdmin,
// requireSuperAdminMfa`. Do NOT re-add a per-route `adminOnly` check here —
// `adminOnly` matches role==='admin', the ordinary tenant Studio Owner role,
// which is exactly the access this file must never grant.

const ALLOWED_TABLES = new Set([
  'attendance_logs', 'payments', 'subscriptions', 'invoices', 'outstanding_dues',
  'client_goals', 'transformations', 'face_embeddings', 'notifications', 'message_logs',
  'clients', 'clients_id_seq', 'payments_id_seq', 'attendance_logs_id_seq',
  'subscriptions_id_seq', 'invoices_id_seq',
]);

function validateTableName(tableName) {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  return tableName;
}

async function deleteIfExists(client, tableName) {
  const safe = escapeIdentifier(validateTableName(tableName));
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('public.${safe}') IS NOT NULL THEN
        EXECUTE 'DELETE FROM ${safe}';
      END IF;
    END
    $$;
  `);
}

async function dropIfExists(client, tableName) {
  await client.query(`DROP TABLE IF EXISTS ${escapeIdentifier(validateTableName(tableName))} CASCADE`);
}

/* ══════════════════════════════════════════════════════════════════════
   H-04: Two-step OTP flow for destructive admin operations.
   Step 1 — POST /admin/initiate-reset  → emails a 6-digit OTP
   Step 2 — POST /admin/reset-all-data  → Body: { otp: "123456" }
══════════════════════════════════════════════════════════════════════ */
router.post('/initiate-reset', async (req, res) => {
  try {
    const action = String(req.body?.action || 'reset-all');
    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query(
      `INSERT INTO admin_reset_intents (admin_id, action, otp_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (admin_id, action) DO UPDATE
         SET otp_hash = EXCLUDED.otp_hash,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()`,
      [req.user.id, action, otpHash, expiresAt],
    );

    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = rows[0]?.email;
    if (email) {
      await sendAdminResetOtp(email, otp);
    } else {
      logger.warn({ adminId: req.user.id }, 'Admin reset OTP could not be sent — email not found');
    }

    res.json({ message: 'OTP sent to your registered email address. It expires in 10 minutes.' });
  } catch (err) {
    logger.error({ err: err.message }, 'initiate-reset error');
    res.status(500).json({ error: 'Server error' });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   POST /admin/reset-all-data
   Body: { otp: "123456" }
══════════════════════════════════════════════════════════════════════ */
router.post('/reset-all-data', async (req, res) => {
  const otp = String(req.body?.otp || '');
  if (!otp) {
    return res.status(400).json({ error: 'OTP required. Call /admin/initiate-reset first to receive a code.' });
  }
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  const { rows: intent } = await pool.query(
    `DELETE FROM admin_reset_intents
      WHERE admin_id = $1 AND action = 'reset-all'
        AND otp_hash = $2 AND expires_at > NOW()
      RETURNING id`,
    [req.user.id, otpHash],
  );
  if (!intent.length) {
    return res.status(400).json({ error: 'Invalid or expired OTP.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await deleteIfExists(client, 'attendance_logs');
    await deleteIfExists(client, 'payments');
    await deleteIfExists(client, 'subscriptions');
    await deleteIfExists(client, 'invoices');
    await dropIfExists(client, 'outstanding_dues');
    await deleteIfExists(client, 'client_goals');
    await deleteIfExists(client, 'transformations');
    await deleteIfExists(client, 'face_embeddings');
    await deleteIfExists(client, 'notifications');
    await deleteIfExists(client, 'message_logs');
    if ((await client.query("SELECT to_regclass('public.clients') AS exists")).rows[0].exists) {
      await client.query(`UPDATE clients SET balance_amount = 0 WHERE COALESCE(balance_amount, 0) <> 0`);
      await client.query(`DELETE FROM clients`);
    }

    const seqs = [
      'clients_id_seq',
      'payments_id_seq',
      'attendance_logs_id_seq',
      'subscriptions_id_seq',
      'invoices_id_seq',
    ];
    for (const seq of seqs) {
      try {
        await client.query(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
      } catch { /* sequence may not exist in this schema — skip */ }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'All member data, payments, attendance, and related records have been cleared safely. Missing legacy tables were skipped automatically.' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message }, 'Reset all data error');
    res.status(500).json({ error: 'Reset failed. Check server logs.' });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   POST /admin/reset-outstanding-dues
   Body: { otp: "123456" }  (OTP from /initiate-reset?action=reset-dues)
══════════════════════════════════════════════════════════════════════ */
router.post('/reset-outstanding-dues', async (req, res) => {
  const otp = String(req.body?.otp || '');
  if (!otp) {
    return res.status(400).json({ error: 'OTP required. Call /admin/initiate-reset with action=reset-dues first.' });
  }
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  const { rows: intent } = await pool.query(
    `DELETE FROM admin_reset_intents
      WHERE admin_id = $1 AND action = 'reset-dues'
        AND otp_hash = $2 AND expires_at > NOW()
      RETURNING id`,
    [req.user.id, otpHash],
  );
  if (!intent.length) {
    return res.status(400).json({ error: 'Invalid or expired OTP.' });
  }
  try {
    await dropIfExists(pool, 'outstanding_dues');
    await deleteIfExists(pool, 'payments');
    const hasClients = (await pool.query("SELECT to_regclass('public.clients') AS exists")).rows[0].exists;
    if (hasClients) {
      await pool.query(`UPDATE clients SET balance_amount = 0 WHERE COALESCE(balance_amount, 0) <> 0`).catch(() => {});
    }
    res.json({ success: true, message: 'Payments and dues-related data cleared safely, and client balances were reset to zero.' });
  } catch (err) {
    logger.error({ err: err.message }, 'Reset dues error');
    res.status(500).json({ error: 'Operation failed. Check server logs.' });
  }
});


// Legacy alias — delegates to reset-outstanding-dues (same OTP required)
router.post('/clear-dues-and-payments', (req, res, next) => {
  req.url = '/reset-outstanding-dues';
  router.handle(req, res, next);
});

module.exports = router;
