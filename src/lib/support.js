// src/lib/support.js
//
// Shared support-ticket logic, so the tenant side and the platform side cannot
// drift apart on the rules that matter.
//
// ── The one rule ─────────────────────────────────────────────────────────────
//
// INTERNAL NOTES NEVER REACH THE TENANT. An operator's note on a studio's own
// ticket is commentary about that customer, written for other operators. It is
// kept out by three independent mechanisms, because any one of them alone is a
// single point of failure for a leak:
//
//   1. `TENANT_MESSAGE_SQL` below filters `is_internal = FALSE`, and it is the
//      only query the tenant route uses.
//   2. The tenant route never reads `is_internal` from a request body, so a
//      studio cannot author one.
//   3. A CHECK constraint (migration 127) forbids an internal note from the
//      studio side at all.
'use strict';

const VALID_STATUS = ['open', 'pending', 'resolved', 'closed'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'urgent'];
const VALID_CATEGORY = ['general', 'billing', 'technical', 'feature_request', 'bug', 'account'];

const SUBJECT_MAX = 200;
const BODY_MAX = 10000;

/** The ONLY message query a tenant-facing path may use. */
const TENANT_MESSAGE_SQL = `
  SELECT id, ticket_id, author_side, author_name, body, created_at
    FROM support_ticket_messages
   WHERE ticket_id = $1 AND is_internal = FALSE
   ORDER BY created_at`;

/** The platform sees everything, internal notes included. */
const PLATFORM_MESSAGE_SQL = `
  SELECT id, ticket_id, author_side, author_id, author_name, body, is_internal, created_at
    FROM support_ticket_messages
   WHERE ticket_id = $1
   ORDER BY created_at`;

/**
 * Add a message and move the ticket's clocks and status in one transaction.
 *
 * Status transitions are a consequence of who spoke, not a separate decision an
 * operator has to remember:
 *   - a studio reply reopens a pending/resolved ticket (they still need us)
 *   - a platform reply moves an open ticket to pending (we are waiting on them)
 *   - an INTERNAL note moves nothing — the studio was never told anything, so
 *     claiming we responded would corrupt the response-time figures.
 *
 * @param {object} db pool
 * @param {object} m { ticketId, side, authorId, authorName, body, isInternal }
 */
async function addMessage(db, m) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [ticket] } = await client.query(
      'SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE', [m.ticketId]
    );
    if (!ticket) { await client.query('ROLLBACK'); return null; }
    if (ticket.status === 'closed') {
      await client.query('ROLLBACK');
      return { closed: true };
    }

    const isInternal = m.side === 'platform' && Boolean(m.isInternal);

    const { rows: [msg] } = await client.query(
      `INSERT INTO support_ticket_messages
         (ticket_id, author_side, author_id, author_name, body, is_internal)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [m.ticketId, m.side, m.authorId || null, m.authorName || null, m.body, isInternal]
    );

    if (!isInternal) {
      // first_response_at is stamped once, on the first thing the STUDIO
      // actually sees. COALESCE keeps a later reply from resetting it.
      const nextStatus = m.side === 'platform'
        ? (ticket.status === 'open' ? 'pending' : ticket.status)
        : (ticket.status === 'resolved' || ticket.status === 'pending' ? 'open' : ticket.status);

      await client.query(
        `UPDATE support_tickets
            SET status = $2,
                first_response_at = CASE WHEN $3 THEN COALESCE(first_response_at, now()) ELSE first_response_at END,
                -- Reopening must clear the resolution time, or the ticket
                -- carries a resolved_at while sitting open and the CHECK
                -- constraint rejects the row.
                resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN resolved_at ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [m.ticketId, nextStatus, m.side === 'platform']
      );
    } else {
      await client.query('UPDATE support_tickets SET updated_at = now() WHERE id = $1', [m.ticketId]);
    }

    await client.query('COMMIT');
    return { message: msg };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Shared validation, so the two sides cannot disagree about what is allowed. */
function validateNewTicket(body) {
  const subject = String(body?.subject ?? '').trim();
  const message = String(body?.body ?? '').trim();
  if (!subject) return { error: 'A subject is required.' };
  if (subject.length > SUBJECT_MAX) return { error: `Subject must be ${SUBJECT_MAX} characters or fewer.` };
  if (!message) return { error: 'A message is required.' };
  if (message.length > BODY_MAX) return { error: `Message must be ${BODY_MAX} characters or fewer.` };

  const category = body?.category ?? 'general';
  if (!VALID_CATEGORY.includes(category)) return { error: `category must be one of ${VALID_CATEGORY.join(', ')}` };
  const priority = body?.priority ?? 'normal';
  if (!VALID_PRIORITY.includes(priority)) return { error: `priority must be one of ${VALID_PRIORITY.join(', ')}` };

  return { value: { subject, body: message, category, priority } };
}

module.exports = {
  VALID_STATUS, VALID_PRIORITY, VALID_CATEGORY, SUBJECT_MAX, BODY_MAX,
  TENANT_MESSAGE_SQL, PLATFORM_MESSAGE_SQL, addMessage, validateNewTicket,
};
