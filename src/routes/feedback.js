'use strict';
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(auth, adminOnly);

// GET /api/feedback
router.get('/', async (req, res, next) => {
  try {
    const { status, type, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    if (status) { conditions.push(`status = $${values.length + 1}`); values.push(status); }
    if (type)   { conditions.push(`type = $${values.length + 1}`);   values.push(type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT id, rating, message, reply, status,
              member_name                AS member,
              type                       AS category,
              created_at                 AS date,
              CASE
                WHEN rating >= 4 THEN 'positive'
                WHEN rating <= 2 THEN 'negative'
                ELSE 'neutral'
              END                        AS sentiment
       FROM feedback ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/feedback/stats
router.get('/stats', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE status = 'open')         AS open,
        COUNT(*) FILTER (WHERE status = 'resolved')     AS resolved,
        ROUND(AVG(rating)::NUMERIC, 1)                  AS avg_rating,
        COUNT(*) FILTER (WHERE rating >= 4)             AS positive,
        COUNT(*) FILTER (WHERE rating <= 2)             AS negative,
        CASE WHEN COUNT(rating) = 0 THEN 0
          ELSE ROUND(
            (COUNT(*) FILTER (WHERE rating >= 4)::NUMERIC -
             COUNT(*) FILTER (WHERE rating <= 2)::NUMERIC)
            / COUNT(rating)::NUMERIC * 100
          )
        END                                             AS nps
      FROM feedback
    `);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/feedback/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM feedback WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/feedback — submit feedback (no auth required for members)
router.post('/', async (req, res, next) => {
  try {
    const { member_id, member_name, type, rating, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await pool.query(
      `INSERT INTO feedback (member_id, member_name, type, rating, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [member_id || null, member_name || null, type || 'general', rating || null, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/feedback/:id/reply
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: 'reply is required' });
    const result = await pool.query(
      `UPDATE feedback
       SET reply = $1, replied_at = NOW(), status = 'replied', updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reply, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ message: 'Reply sent' });
  } catch (err) { next(err); }
});

// POST /api/feedback/:id/resolve
router.post('/:id/resolve', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE feedback SET status = 'resolved', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ message: 'Feedback resolved' });
  } catch (err) { next(err); }
});

// DELETE /api/feedback/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM feedback WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
