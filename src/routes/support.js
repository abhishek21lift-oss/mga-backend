// src/routes/support.js
//
// The studio's side of support: raise a ticket, read the thread, reply.
//
// Every query is scoped to req.user.organization_id and there is no parameter
// anywhere that names a studio — the organization comes off the authenticated
// session and nowhere else, so no amount of request tampering reaches another
// tenant's tickets.
//
// Internal operator notes are excluded by lib/support.TENANT_MESSAGE_SQL, which
// is the only message query this file uses. See that module's header for why
// the exclusion is enforced three separate ways.
'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const support = require('../lib/support');
const { auth } = require('../middleware/auth');

// Declared by the router itself, so mounting it can never leave it open.
router.use(auth);

/** A platform operator has no tickets of their own; they use the Control Centre. */
function tenantOrg(req, res) {
  const orgId = req.user?.organization_id;
  if (!orgId || req.user.role === 'super_admin') {
    res.status(403).json({ error: { code: 'TENANT_ONLY', message: 'Support tickets belong to a studio.' } });
    return null;
  }
  return orgId;
}

// ── GET /api/support/tickets ────────────────────────────────────────────────
router.get('/tickets', async (req, res, next) => {
  try {
    const orgId = tenantOrg(req, res);
    if (!orgId) return undefined;

    const { rows } = await pool.query(
      `SELECT t.id, t.subject, t.category, t.priority, t.status,
              t.created_by_name, t.created_at, t.updated_at, t.resolved_at,
              -- The studio's own count, so an internal note never makes a
              -- thread look longer than what they can actually read.
              (SELECT count(*)::int FROM support_ticket_messages m
                WHERE m.ticket_id = t.id AND m.is_internal = FALSE) AS message_count
         FROM support_tickets t
        WHERE t.organization_id = $1::uuid
        ORDER BY t.updated_at DESC
        LIMIT 200`,
      [orgId]
    );
    return res.json({ data: rows });
  } catch (err) { return next(err); }
});

// ── POST /api/support/tickets ───────────────────────────────────────────────
router.post('/tickets', async (req, res, next) => {
  try {
    const orgId = tenantOrg(req, res);
    if (!orgId) return undefined;

    const { error, value } = support.validateNewTicket(req.body);
    if (error) return res.status(400).json({ error: { code: 'VALIDATION', message: error } });

    const { rows: [ticket] } = await pool.query(
      `INSERT INTO support_tickets
         (organization_id, subject, category, priority, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, value.subject, value.category, value.priority, req.user.id, req.user.name || null]
    );

    // The opening message is part of the thread, not a field on the ticket —
    // otherwise the first thing said lives somewhere different from everything
    // said afterwards.
    await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, author_side, author_id, author_name, body)
       VALUES ($1,'studio',$2,$3,$4)`,
      [ticket.id, req.user.id, req.user.name || null, value.body]
    );

    return res.status(201).json({ data: ticket });
  } catch (err) { return next(err); }
});

// ── GET /api/support/tickets/:id ────────────────────────────────────────────
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const orgId = tenantOrg(req, res);
    if (!orgId) return undefined;

    // The organization_id predicate is on the TICKET lookup, so a ticket
    // belonging to another studio is a 404 here and its messages are never
    // reached at all.
    const { rows: [ticket] } = await pool.query(
      `SELECT id, subject, category, priority, status, created_by_name,
              created_at, updated_at, resolved_at
         FROM support_tickets WHERE id = $1 AND organization_id = $2::uuid`,
      [req.params.id, orgId]
    );
    if (!ticket) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    const { rows: messages } = await pool.query(support.TENANT_MESSAGE_SQL, [ticket.id]);
    return res.json({ data: { ...ticket, messages } });
  } catch (err) { return next(err); }
});

// ── POST /api/support/tickets/:id/messages ──────────────────────────────────
router.post('/tickets/:id/messages', async (req, res, next) => {
  try {
    const orgId = tenantOrg(req, res);
    if (!orgId) return undefined;

    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A message is required.' } });
    if (body.length > support.BODY_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Message must be ${support.BODY_MAX} characters or fewer.` } });
    }

    const { rows: [owned] } = await pool.query(
      'SELECT id FROM support_tickets WHERE id = $1 AND organization_id = $2::uuid',
      [req.params.id, orgId]
    );
    if (!owned) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    // isInternal is deliberately NOT read from req.body — a studio cannot
    // author an operator-only note even by asking for one.
    const result = await support.addMessage(pool, {
      ticketId: req.params.id, side: 'studio',
      authorId: req.user.id, authorName: req.user.name || null, body,
    });
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
    if (result.closed) {
      return res.status(409).json({ error: { code: 'TICKET_CLOSED', message: 'This ticket is closed. Raise a new one and we will pick it up.' } });
    }

    return res.status(201).json({ data: result.message });
  } catch (err) { return next(err); }
});

module.exports = router;
