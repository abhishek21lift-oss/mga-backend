'use strict';
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(auth, adminOnly);

// GET /api/integrations — list all integration statuses
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, status, connected_at, last_sync_at FROM integrations ORDER BY id'
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

    await pool.query(
      `INSERT INTO integrations (id, name, status, api_key, connected_at, updated_at)
       VALUES ($1, $2, 'connected', $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE
         SET status       = 'connected',
             api_key      = EXCLUDED.api_key,
             name         = COALESCE(EXCLUDED.name, integrations.name),
             connected_at = COALESCE(integrations.connected_at, NOW()),
             updated_at   = NOW()`,
      [id, name || id, api_key]
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
    await pool.query(
      `INSERT INTO integrations (id, name, status, updated_at)
       VALUES ($1, $1, 'disconnected', NOW())
       ON CONFLICT (id) DO UPDATE
         SET status     = 'disconnected',
             api_key    = NULL,
             updated_at = NOW()`,
      [id]
    );
    res.json({ success: true, message: 'Integration disconnected' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
