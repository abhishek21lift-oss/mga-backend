'use strict';
// Support centre (platform side) — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, pool,
} = require('./shared');
// ═══════════════════════════════════════════════════════════════════════════
//  SUPPORT CENTRE
//
//  The platform's side of the conversation studios start at /api/support.
//
//  Operators see everything on a ticket, internal notes included. Those notes
//  are never returned by any tenant path — see lib/support.js for the three
//  independent mechanisms keeping them out, and why one would not be enough.
// ═══════════════════════════════════════════════════════════════════════════

const support = require('../../../lib/support');

const TICKET_PAGE_MAX = 200;

// Urgent first, then oldest — an operator working a queue wants the most
// pressing thing that has been waiting longest, not the newest arrival.
const TICKET_ORDER = `
  ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                           WHEN 'normal' THEN 2 ELSE 3 END,
           t.created_at`;

// ── GET /support/overview ────────────────────────────────────────────────────
router.get('/support/overview', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'open')::int      AS open,
              count(*) FILTER (WHERE status = 'pending')::int   AS pending,
              count(*) FILTER (WHERE status = 'resolved')::int  AS resolved,
              count(*) FILTER (WHERE status = 'closed')::int    AS closed,
              -- The queue an operator actually works: nobody owns these.
              count(*) FILTER (WHERE assigned_to IS NULL AND status IN ('open','pending'))::int AS unassigned,
              count(*) FILTER (WHERE priority = 'urgent' AND status IN ('open','pending'))::int AS urgent_live,
              -- Never answered at all, and still waiting. The worst state a
              -- support function can be in, so it gets its own number rather
              -- than hiding inside "open".
              count(*) FILTER (WHERE first_response_at IS NULL AND status IN ('open','pending'))::int AS awaiting_first_reply,
              -- Medians, not means: one ticket that sat over a weekend would
              -- drag an average past the point of being useful.
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600
              ) FILTER (WHERE first_response_at IS NOT NULL)  AS median_first_response_hours,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600
              ) FILTER (WHERE resolved_at IS NOT NULL)        AS median_resolution_hours
         FROM support_tickets`
    );
    const r = rows[0];
    res.json({
      data: {
        ...r,
        median_first_response_hours: r.median_first_response_hours === null
          ? null : Math.round(Number(r.median_first_response_hours) * 10) / 10,
        median_resolution_hours: r.median_resolution_hours === null
          ? null : Math.round(Number(r.median_resolution_hours) * 10) / 10,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /support/tickets ─────────────────────────────────────────────────────
router.get('/support/tickets', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, TICKET_PAGE_MAX);
    const where = []; const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };

    if (req.query.status) add('t.status = $?', req.query.status);
    if (req.query.priority) add('t.priority = $?', req.query.priority);
    if (req.query.category) add('t.category = $?', req.query.category);
    if (req.query.org_id) add('t.organization_id = $?::uuid', req.query.org_id);
    // "Show me the queue" — the single most common thing an operator wants.
    if (req.query.unassigned === 'true') where.push('t.assigned_to IS NULL');
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const i = `$${params.length}`;
      where.push(`(t.subject ILIKE ${i} OR o.name ILIKE ${i})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT t.*, o.name AS organization_name, o.plan_code,
              (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
              (SELECT max(created_at) FROM support_ticket_messages m
                WHERE m.ticket_id = t.id AND m.author_side = 'studio') AS last_studio_message_at
         FROM support_tickets t
         JOIN organizations o ON o.id = t.organization_id
         ${clause}
         ${TICKET_ORDER}
         LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /support/tickets/:id ─────────────────────────────────────────────────
router.get('/support/tickets/:id', async (req, res, next) => {
  try {
    const { rows: [ticket] } = await pool.query(
      `SELECT t.*, o.name AS organization_name, o.plan_code, o.subscription_status
         FROM support_tickets t
         JOIN organizations o ON o.id = t.organization_id
        WHERE t.id = $1`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    const { rows: messages } = await pool.query(support.PLATFORM_MESSAGE_SQL, [ticket.id]);
    return res.json({ data: { ...ticket, messages } });
  } catch (err) { return next(err); }
});

// ── POST /support/tickets/:id/messages ───────────────────────────────────────
router.post('/support/tickets/:id/messages', async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A message is required.' } });
    if (body.length > support.BODY_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Message must be ${support.BODY_MAX} characters or fewer.` } });
    }

    const result = await support.addMessage(pool, {
      ticketId: req.params.id, side: 'platform',
      authorId: req.user?.id, authorName: req.user?.name || null,
      body, isInternal: Boolean(req.body?.is_internal),
    });
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
    if (result.closed) {
      return res.status(409).json({ error: { code: 'TICKET_CLOSED', message: 'This ticket is closed. Reopen it before replying.' } });
    }

    // An internal note is not something that happened to the studio, so it is
    // audited as a note rather than as a reply.
    await audit(req, result.message.is_internal ? 'support_note_added' : 'support_replied',
      'support_ticket', req.params.id, { internal: result.message.is_internal });
    return res.status(201).json({ data: result.message });
  } catch (err) { return next(err); }
});

// ── PATCH /support/tickets/:id ───────────────────────────────────────────────
// Status, priority and assignment. Status is the delicate one: the CHECK
// constraint in migration 127 requires resolved_at to agree with it, so the
// timestamp is moved here rather than left to the caller.
router.patch('/support/tickets/:id', async (req, res, next) => {
  try {
    const { rows: [before] } = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    const sets = []; const params = [req.params.id];
    const push = (sql, v) => { params.push(v); sets.push(sql.replace('$?', `$${params.length}`)); };

    if (req.body?.status !== undefined) {
      if (!support.VALID_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `status must be one of ${support.VALID_STATUS.join(', ')}` } });
      }
      push('status = $?', req.body.status);
      // Resolving stamps the clock once; reopening clears it, or the row
      // violates the coherence constraint.
      if (['resolved', 'closed'].includes(req.body.status)) {
        sets.push('resolved_at = COALESCE(resolved_at, now())');
      } else {
        sets.push('resolved_at = NULL');
      }
    }
    if (req.body?.priority !== undefined) {
      if (!support.VALID_PRIORITY.includes(req.body.priority)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `priority must be one of ${support.VALID_PRIORITY.join(', ')}` } });
      }
      push('priority = $?', req.body.priority);
    }
    if (req.body?.assigned_to !== undefined) {
      if (req.body.assigned_to === null) {
        sets.push('assigned_to = NULL', 'assigned_to_name = NULL');
      } else {
        // Only a platform operator can own a ticket — assigning one to a
        // tenant user would put a studio in charge of its own complaint.
        const { rows: [op] } = await pool.query(
          `SELECT id, name FROM users WHERE id = $1 AND role = 'super_admin' AND deleted_at IS NULL`,
          [req.body.assigned_to]
        );
        if (!op) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A ticket can only be assigned to a platform operator.' } });
        push('assigned_to = $?', op.id);
        push('assigned_to_name = $?', op.name);
      }
    }

    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });

    const { rows } = await pool.query(
      `UPDATE support_tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'support_ticket_updated','support_ticket',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.id,
       { status: before.status, priority: before.priority, assigned_to_name: before.assigned_to_name },
       { status: rows[0].status, priority: rows[0].priority, assigned_to_name: rows[0].assigned_to_name },
       req.ip || null, req.get('user-agent') || null]
    );

    return res.json({ data: rows[0] });
  } catch (err) { return next(err); }
});

module.exports = router;
