const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

router.get('/sessions', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { applyFilter, orgId } = tenantScope(req);
    // class_sessions stores date/start_time/end_time separately, and its
    // instructor FK is instructor_id — this query previously referenced
    // starts_at/ends_at/trainer_id, none of which exist on the table, so it
    // errored on every call regardless of who was asking.
    const { rows } = await pool.query(`
      SELECT
        cs.id AS session_id,
        (cs.date + cs.start_time) AS starts_at,
        (cs.date + cs.end_time)   AS ends_at,
        cs.capacity,
        ct.name AS class_name,
        ct.category,
        t.name AS trainer_name,
        COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0)::int AS confirmed,
        GREATEST(0, cs.capacity - COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0))::int AS spots_left
      FROM class_sessions cs
      JOIN class_templates ct ON ct.id = cs.template_id
      LEFT JOIN trainers t ON t.id = cs.instructor_id
      WHERE (cs.date + cs.start_time >= $1 OR $1 IS NULL)
        AND (cs.date + cs.start_time <= $2 OR $2 IS NULL)
        AND ($3::uuid IS NULL OR cs.organization_id = $3)
      ORDER BY cs.date, cs.start_time
    `, [from || new Date().toISOString(), to || null, applyFilter ? orgId : null]);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
