'use strict';
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, adminOnly);

// Null-safe tenant param: for a tenant user this is their org id (queries then
// filter `organization_id = $x`); for a platform super admin operating
// platform-wide it is NULL, and `$x IS NULL OR organization_id = $x` matches
// every row (god-mode). A super admin targeting one org via x-org-id filters.
function orgParam(req) {
  const scope = tenantScope(req);
  return scope.applyFilter ? scope.orgId : null;
}

// GET /api/communication/history
router.get('/history', async (req, res, next) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    if (type) { conditions.push(`type = $${values.length + 1}`); values.push(type); }
    // Tenant isolation: an admin sees only their own studio's sent-message log
    // (null-safe for a platform super admin, who sees all).
    values.push(orgParam(req));
    conditions.push(`($${values.length}::uuid IS NULL OR organization_id = $${values.length})`);
    const where = `WHERE ${conditions.join(' AND ')}`;
    values.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT id, title, body, type, audience, recipients, status, sent_by, sent_at
       FROM communication_history ${where}
       ORDER BY sent_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/communication/history/:id
router.get('/history/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, body, type, audience, recipients, status, sent_by, sent_at
         FROM communication_history
        WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [req.params.id, orgParam(req)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/communication/send
router.post('/send', async (req, res, next) => {
  try {
    const { title, body, type, audience, recipients } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    // Count recipients if not explicitly provided. `clients` is legacy and
    // empty in this deployment — real client rows live in pt_clients, so
    // every audience except 'pt' unions both. Neither table has an
    // expiry_date/subscription_end_date/balance_due/user_id column despite
    // the original queries here assuming they did (would hard-error on
    // 'expiring'/'dues', and silently notify nobody on 'all'/'expired');
    // pt_end_date and balance_amount are the real columns.
    // Tenant isolation: recipient targeting must never reach another tenant's
    // clients. pt_clients is filtered to the caller's org ($1, null-safe for
    // super admins). The legacy `clients` union is empty in this deployment.
    const org = orgParam(req);
    let recipientCount = recipients;
    if (!recipientCount) {
      if (audience === 'expiring') {
        const r = await pool.query(`
          SELECT COUNT(*) FROM (
            SELECT id FROM clients WHERE status = 'active' AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
            UNION ALL
            SELECT id FROM pt_clients WHERE deleted_at IS NULL AND status = 'active' AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
              AND ($1::uuid IS NULL OR organization_id = $1)
          ) x`, [org]);
        recipientCount = Number(r.rows[0].count);
      } else if (audience === 'dues') {
        const r = await pool.query(`
          SELECT COUNT(*) FROM (
            SELECT id FROM clients WHERE status = 'active' AND balance_amount > 0
            UNION ALL
            SELECT id FROM pt_clients WHERE deleted_at IS NULL AND status = 'active' AND balance_amount > 0
              AND ($1::uuid IS NULL OR organization_id = $1)
          ) x`, [org]);
        recipientCount = Number(r.rows[0].count);
      } else if (audience === 'pt') {
        const r = await pool.query(
          "SELECT COUNT(*) FROM pt_clients WHERE deleted_at IS NULL AND status = 'active' AND ($1::uuid IS NULL OR organization_id = $1)", [org]);
        recipientCount = Number(r.rows[0].count);
      } else if (audience === 'expired') {
        const r = await pool.query(`
          SELECT COUNT(*) FROM (
            SELECT id FROM clients WHERE status = 'expired'
            UNION ALL
            SELECT id FROM pt_clients WHERE deleted_at IS NULL AND status = 'expired'
              AND ($1::uuid IS NULL OR organization_id = $1)
          ) x`, [org]);
        recipientCount = Number(r.rows[0].count);
      } else {
        // 'all' or unspecified
        const r = await pool.query(`
          SELECT COUNT(*) FROM (
            SELECT id FROM clients WHERE status = 'active'
            UNION ALL
            SELECT id FROM pt_clients WHERE deleted_at IS NULL AND status = 'active'
              AND ($1::uuid IS NULL OR organization_id = $1)
          ) x`, [org]);
        recipientCount = Number(r.rows[0].count);
      }
    }

    const result = await pool.query(
      `INSERT INTO communication_history (title, body, type, audience, recipients, status, sent_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, 'sent', $6, $7)
       RETURNING *`,
      [title, body, type || 'announcement', audience || 'all', recipientCount, req.user?.id, org]
    );

    // Broadcast in-app notification to all active members with a login
    // (fire-and-forget). `clients`/`pt_clients` have no user_id column —
    // the link is users.member_id, same as the webauthn/passkey flows.
    pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       SELECT u.id, 'announcement', $1, $2
         FROM users u
        WHERE u.is_active = true
          AND ($3::uuid IS NULL OR u.organization_id = $3)
          AND u.member_id IN (
            SELECT id FROM clients WHERE status = 'active'
            UNION
            SELECT id FROM pt_clients WHERE deleted_at IS NULL AND status = 'active'
              AND ($3::uuid IS NULL OR organization_id = $3)
          )
        LIMIT 500`,
      [title, body, org]
    ).catch(() => {});

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/communication/history/:id
router.delete('/history/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM communication_history WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2) RETURNING id',
      [req.params.id, orgParam(req)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
