const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

router.get('/sessions', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { rows } = await pool.query(`
      SELECT
        cs.id AS session_id,
        cs.starts_at,
        cs.ends_at,
        cs.capacity,
        ct.name AS class_name,
        ct.category,
        t.name AS trainer_name,
        COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0)::int AS confirmed,
        GREATEST(0, cs.capacity - COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0))::int AS spots_left
      FROM class_sessions cs
      JOIN class_templates ct ON ct.id = cs.template_id
      LEFT JOIN trainers t ON t.id = cs.trainer_id
      WHERE (cs.starts_at >= $1 OR $1 IS NULL)
        AND (cs.starts_at <= $2 OR $2 IS NULL)
      ORDER BY cs.starts_at
    `, [from || new Date().toISOString(), to || null]);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
