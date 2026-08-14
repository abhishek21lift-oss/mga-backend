// src/modules/notifications/notifications.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { orgIdOf } = require('../../lib/tenant-db');
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
// V-11: every recipient id is resolved inside the caller's organization.
//
// Without the orgId argument this accepted another studio's member id and
// messaged that person — a cross-tenant write with the sender's identity on it.
// It was inert while the person tables were empty; migration 166 fills them.
//
// Ids that do not resolve are skipped rather than failing the whole request,
// and the response reports both counts. Failing the batch would let a caller
// probe for another studio's ids by watching which requests 500.
router.post('/broadcast', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { type, member_ids, data, channels } = req.body;
  const orgId = orgIdOf(req);
  const sent = [];
  let skipped = 0;
  for (const mid of member_ids || []) {
    let r;
    try {
      r = await svc.recipientFromMember(mid, orgId);
    } catch {
      skipped += 1;
      continue;
    }
    sent.push(await svc.send(type, r, data || {}, channels || ['inapp']));
  }
  res.json({ data: { count: sent.length, skipped } });
}));

module.exports = router;
