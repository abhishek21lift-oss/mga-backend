'use strict';
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(auth, adminOnly);

// GET /api/campaigns
router.get('/', async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const conditions = [];
    const values = [];
    if (status) { conditions.push(`status = $${values.length + 1}`); values.push(status); }
    if (type)   { conditions.push(`type = $${values.length + 1}`);   values.push(type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, name, status, audience,
              type            AS channel,
              subject         AS goal,
              scheduled_at    AS start,
              sent_at         AS end,
              sent_count      AS sent,
              open_count      AS opened,
              conversions     AS converted,
              created_at, updated_at
       FROM campaigns ${where} ORDER BY created_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/campaigns/stats
router.get('/stats', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')        AS active,
        COALESCE(SUM(sent_count), 0)                     AS total_sent,
        COALESCE(SUM(conversions), 0)                    AS conversions,
        CASE WHEN COALESCE(SUM(sent_count), 0) = 0 THEN 0
          ELSE ROUND(SUM(conversions)::NUMERIC / SUM(sent_count) * 100, 1)
        END                                               AS conv_rate
      FROM campaigns
    `);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/campaigns — accepts frontend field names (channel/goal/start) or backend names (type/subject/scheduled_at)
router.post('/', async (req, res, next) => {
  try {
    const { name, type, channel, audience, subject, goal, body, scheduled_at, start, end, sent_at, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      `INSERT INTO campaigns (name, type, audience, subject, body, scheduled_at, sent_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, status, audience,
                 type AS channel, subject AS goal, scheduled_at AS start,
                 sent_at AS end, sent_count AS sent, open_count AS opened,
                 conversions AS converted, created_at`,
      [name, type || channel || 'email', audience || 'all', subject || goal || null, body || null, scheduled_at || start || null, sent_at || end || null, status || 'draft', req.user?.id]
    );
    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { name, type, audience, subject, body, scheduled_at, status } = req.body;
    const result = await pool.query(
      `UPDATE campaigns
       SET name = COALESCE($1, name),
           type = COALESCE($2, type),
           audience = COALESCE($3, audience),
           subject = COALESCE($4, subject),
           body = COALESCE($5, body),
           scheduled_at = $6,
           status = COALESCE($7, status),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, type, audience, subject, body, scheduled_at || null, status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM campaigns WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ message: 'Campaign deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
