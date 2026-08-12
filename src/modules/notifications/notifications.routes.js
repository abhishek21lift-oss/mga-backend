// src/modules/notifications/notifications.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const svc = require('./notifications.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/v1/notifications  — current user's inbox
router.get('/', auth, wrap(async (req, res) => {
  const data = await svc.inbox(req.user.id, { unreadOnly: req.query.unread === '1' });
  res.json({ data });
}));

// PATCH /api/v1/notifications/read-all  — mark all as read
router.patch('/read-all', auth, wrap(async (req, res) => {
  await svc.markAllRead(req.user.id);
  res.status(204).end();
}));

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', auth, wrap(async (req, res) => {
  await svc.markRead(req.params.id, req.user.id);
  res.status(204).end();
}));

// POST /api/v1/notifications/broadcast  — admin only
router.post('/broadcast', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { type, member_ids, data, channels } = req.body;
  const sent = [];
  for (const mid of member_ids || []) {
    const r = await svc.recipientFromMember(mid);
    sent.push(await svc.send(type, r, data || {}, channels || ['inapp']));
  }
  res.json({ data: { count: sent.length } });
}));

module.exports = router;
