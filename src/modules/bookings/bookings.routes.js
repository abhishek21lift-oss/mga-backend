// src/modules/bookings/bookings.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const svc = require('./bookings.service');
const cal = require('../../lib/google-calendar');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ctx = (req) => ({
  user_id: req.user.id, user_name: req.user.name, organization_id: req.user.organization_id,
  role: req.user.role, trainer_id: req.user.trainer_id, member_id: req.user.member_id,
});

// GET /api/v1/bookings  — current user's bookings
router.get('/', auth, wrap(async (req, res) => {
  let memberId = req.query.member_id;
  if (req.user.role === 'member') memberId = req.user.member_id;
  if (!memberId) return res.json({ data: [] });
  const data = await svc.listForMember(memberId, req.query, ctx(req));
  res.json({ data });
}));

// POST /api/v1/bookings  — book a class
router.post('/', auth, wrap(async (req, res) => {
  let memberId = req.body.member_id;
  if (req.user.role === 'member') memberId = req.user.member_id;
  if (!memberId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'member_id required' } });
  const booking = await svc.book({ session_id: req.body.session_id, member_id: memberId }, ctx(req));
  res.status(201).json({ data: booking });
  // Fire-and-forget: sync confirmed bookings to the user's Google Calendar.
  // A calendar failure must never fail the booking itself.
  if (booking.status === 'confirmed' && cal.isConfigured()) {
    cal.createBookingEvent(req.user.id, booking.id).catch(() => {});
  }
}));

// DELETE /api/v1/bookings/:id  — cancel
router.delete('/:id', auth, wrap(async (req, res) => {
  const bookingId = req.params.id;
  const result = await svc.cancel(bookingId, { reason: req.body?.reason }, ctx(req));
  res.json({ data: result });
  // Fire-and-forget: remove the cancelled booking from the user's Google Calendar.
  if (cal.isConfigured()) {
    cal.deleteBookingEvent(req.user.id, bookingId).catch(() => {});
  }
}));

// POST /api/v1/bookings/:id/check-in
router.post('/:id/check-in', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const booking = await svc.checkIn(req.params.id, { method: req.body?.method || 'manual' }, ctx(req));
  res.json({ data: booking });
}));

module.exports = router;
