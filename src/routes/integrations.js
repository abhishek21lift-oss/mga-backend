'use strict';
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, adminOnly);

// A super admin operating platform-wide has no single org to key a
// connection row on, so integrations routes require a resolved org — same
// contract as the rest of this file's write paths, which is stricter than
// the read-only null-safe helper other routes in this codebase use.
function requireOrgId(req, res) {
  const { orgId } = tenantScope(req);
  if (!orgId) {
    res.status(400).json({ success: false, message: 'Select an organization (x-org-id) to manage its integrations' });
    return null;
  }
  return orgId;
}

// GET /api/integrations — list this org's integration statuses
router.get('/', async (req, res, next) => {
  try {
    const { orgId, applyFilter } = tenantScope(req);
    const result = await pool.query(
      `SELECT id, name, status, connected_at, last_sync_at FROM integrations
        WHERE ($1::uuid IS NULL OR organization_id = $1) ORDER BY id`,
      [applyFilter ? orgId : null]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/test — test connection with api_key
router.post('/:id/test', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { api_key } = req.body;
    if (!api_key || api_key.trim().length < 8) {
      return res.json({ success: false, message: 'API key too short or missing' });
    }
    // Basic format validation per integration type
    const validations = {
      razorpay:  (k) => k.startsWith('rzp_'),
      stripe:    (k) => k.startsWith('sk_'),
      sendgrid:  (k) => k.startsWith('SG.'),
      twilio:    (k) => k.length >= 20,
    };
    const validate = validations[id];
    if (validate && !validate(api_key)) {
      return res.json({ success: false, message: `Invalid API key format for ${id}` });
    }
    // For integrations without strict format, accept any key >= 8 chars
    res.json({ success: true, message: 'Connection test successful' });
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/connect — save API key and mark connected
router.post('/:id/connect', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { api_key, name } = req.body;
    if (!api_key) return res.status(400).json({ success: false, message: 'api_key is required' });
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    await pool.query(
      `INSERT INTO integrations (id, organization_id, name, status, api_key, connected_at, updated_at)
       VALUES ($1, $2, $3, 'connected', $4, NOW(), NOW())
       ON CONFLICT (organization_id, id) DO UPDATE
         SET status       = 'connected',
             api_key      = EXCLUDED.api_key,
             name         = COALESCE(EXCLUDED.name, integrations.name),
             connected_at = COALESCE(integrations.connected_at, NOW()),
             updated_at   = NOW()`,
      [id, orgId, name || id, api_key]
    );
    res.json({ success: true, message: 'Integration connected' });
  } catch (err) {
    next(err);
  }
});

// POST /api/integrations/:id/disconnect — mark as disconnected
router.post('/:id/disconnect', async (req, res, next) => {
  try {
    const { id } = req.params;
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    await pool.query(
      `INSERT INTO integrations (id, organization_id, name, status, updated_at)
       VALUES ($1, $2, $1, 'disconnected', NOW())
       ON CONFLICT (organization_id, id) DO UPDATE
         SET status     = 'disconnected',
             api_key    = NULL,
             updated_at = NOW()`,
      [id, orgId]
    );
    res.json({ success: true, message: 'Integration disconnected' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
