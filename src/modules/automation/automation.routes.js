const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/rules', auth, wrap(async (req, res) => {
  const { trigger_event, is_active } = req.query;
  const where = []; const params = [];
  if (trigger_event) { params.push(trigger_event); where.push(`trigger_event = $${where.length + 1}`); }
  if (is_active !== undefined) { params.push(is_active === 'true'); where.push(`is_active = $${where.length + 1}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ar.*, u.name AS created_by_name FROM automation_rules ar
     LEFT JOIN users u ON u.id = ar.created_by ${whereSql} ORDER BY ar.created_at DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/rules', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { name, trigger_event, channel, template, delay_minutes } = req.body;
  if (!name?.trim() || !trigger_event || !template?.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'name, trigger_event, and template are required' } });
  }
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (name, trigger_event, channel, template, delay_minutes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), trigger_event, channel || 'whatsapp', template, parseInt(delay_minutes) || 0, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/rules/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const allowed = ['name','trigger_event','channel','template','delay_minutes','is_active'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE automation_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

router.delete('/rules/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  await pool.query('DELETE FROM automation_rules WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

router.get('/communication-logs', auth, wrap(async (req, res) => {
  const { channel, status, recipient_type, recipient_id, limit, offset } = req.query;
  const where = []; const params = [];
  if (channel) { params.push(channel); where.push(`channel = $${where.length + 1}`); }
  if (status) { params.push(status); where.push(`status = $${where.length + 1}`); }
  if (recipient_type) { params.push(recipient_type); where.push(`recipient_type = $${where.length + 1}`); }
  if (recipient_id) { params.push(recipient_id); where.push(`recipient_id = $${where.length + 1}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim); params.push(off);
  const { rows } = await pool.query(
    `SELECT * FROM communication_logs ${whereSql} ORDER BY created_at DESC LIMIT $${where.length + 1} OFFSET $${where.length + 2}`, params
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*)::INT AS total FROM communication_logs ${whereSql}`, params.slice(0, -2)
  );
  res.json({ data: rows, total });
}));

router.get('/communication-logs/stats', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::INT AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::INT AS sent,
      COUNT(*) FILTER (WHERE status = 'delivered')::INT AS delivered,
      COUNT(*) FILTER (WHERE status = 'read')::INT AS read,
      COUNT(*) FILTER (WHERE status = 'failed')::INT AS failed,
      COUNT(*) FILTER (WHERE channel = 'whatsapp')::INT AS whatsapp,
      COUNT(*) FILTER (WHERE channel = 'sms')::INT AS sms,
      COUNT(*) FILTER (WHERE channel = 'email')::INT AS email
    FROM communication_logs WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
  `);
  res.json({ data: rows[0] });
}));

router.get('/session-balance', auth, wrap(async (req, res) => {
  const { client_id, status, low_balance } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  if (status) { params.push(status); where.push(`status = $${where.length + 1}`); }
  if (low_balance === 'true') { where.push('remaining_sessions <= 3 AND status = \'active\''); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT sb.*, c.name AS client_name, c.mobile AS client_mobile
     FROM session_balance sb JOIN clients c ON c.id = sb.client_id ${whereSql}
     ORDER BY sb.remaining_sessions ASC, sb.end_date ASC`, params
  );
  res.json({ data: rows });
}));

router.post('/session-balance', auth, wrap(async (req, res) => {
  const { client_id, total_sessions, package_name, start_date, end_date } = req.body;
  if (!client_id || !total_sessions) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'client_id and total_sessions are required' } });
  }
  const { rows } = await pool.query(
    `INSERT INTO session_balance (client_id, total_sessions, used_sessions, package_name, start_date, end_date)
     VALUES ($1,$2,0,$3,$4,$5) RETURNING *`,
    [client_id, parseInt(total_sessions), package_name || null, start_date || new Date().toISOString().split('T')[0], end_date || null]
  );
  res.status(201).json({ data: rows[0] });
}));

router.post('/session-balance/:id/use', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE session_balance SET used_sessions = used_sessions + 1, updated_at = NOW()
     WHERE id = $1 AND used_sessions < total_sessions AND status = 'active' RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: { code: 'BALANCE_EXHAUSTED', message: 'No sessions remaining' } });
  res.json({ data: rows[0] });
}));

router.get('/pt-packages', auth, wrap(async (req, res) => {
  const { goal_type, is_active } = req.query;
  const where = []; const params = [];
  if (goal_type) { params.push(goal_type); where.push(`goal_type = $${where.length + 1}`); }
  if (is_active !== undefined) { params.push(is_active === 'true'); where.push(`is_active = $${where.length + 1}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM pt_packages ${whereSql} ORDER BY price ASC`, params);
  res.json({ data: rows });
}));

router.post('/pt-packages', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, session_count, duration_days, price, goal_type, description } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_packages (name, session_count, duration_days, price, goal_type, description)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, parseInt(session_count), parseInt(duration_days), parseFloat(price), goal_type || null, description || null]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/pt-packages/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const allowed = ['name','session_count','duration_days','price','goal_type','description','is_active'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_packages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

router.delete('/pt-packages/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM pt_packages WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: { id: rows[0].id } });
}));

module.exports = router;
