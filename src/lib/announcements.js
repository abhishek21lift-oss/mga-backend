// src/lib/announcements.js
//
// Platform → studio announcements: who receives one, and the send itself.
//
// Sending is the only irreversible act in the Control Centre. There is no
// unsend — once a notification is in a studio's bell, it has been read or it
// has not, and either way the operator cannot take it back. Everything in this
// file is shaped by that:
//
//   - `resolveRecipients` is used by BOTH the preview and the send, so the
//     count an operator confirms is the count that goes out. A preview
//     computed by different code from the send is a preview of nothing.
//   - `send` is transactional and refuses an announcement that is already
//     sent, so a double-tap or a retried request cannot deliver twice.
//   - The audience is snapshotted onto the row at send time, because
//     recomputing it later would silently rewrite who was told what as
//     studios sign up and churn.
'use strict';

const logger = require('./logger');

/** Studios that are gone are not an audience. */
const LIVE_ORG = `o.status <> 'deleted'`;

/**
 * Build the WHERE clause selecting the targeted studios.
 * Exported so the tests can exercise the targeting rules directly — they are
 * the part where a mistake means the wrong people get the message.
 */
function audienceClause(a) {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };

  let clause;
  switch (a.audience) {
    case 'plan':
      clause = `o.plan_code = ANY(${push(a.audience_plans || [])})`;
      break;
    case 'status':
      // subscription_status, not the super-admin on/off `status` column: an
      // operator targeting "frozen studios" means the billing state.
      clause = `o.subscription_status = ANY(${push(a.audience_statuses || [])})`;
      break;
    case 'studios':
      clause = `o.id = ANY(${push(a.audience_org_ids || [])}::uuid[])`;
      break;
    case 'all':
    default:
      clause = 'TRUE';
  }
  return { clause, params };
}

/**
 * Everyone who would receive this announcement, right now.
 *
 * @param {object} a announcement (audience fields only are read)
 * @param {object} db pool or client
 * @returns {Promise<{users: Array, studio_count: number}>}
 */
async function resolveRecipients(a, db) {
  const { clause, params } = audienceClause(a);
  const roles = a.audience_roles?.length ? a.audience_roles : ['admin', 'manager'];
  params.push(roles);

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role, o.id AS organization_id, o.name AS organization_name
       FROM users u
       JOIN organizations o ON o.id = u.organization_id
      WHERE u.is_active = TRUE
        AND u.deleted_at IS NULL
        -- Platform operators are not an audience for platform announcements.
        AND u.role <> 'super_admin'
        AND u.role = ANY($${params.length})
        AND ${LIVE_ORG}
        AND ${clause}
      ORDER BY o.name, u.name`,
    params
  );

  return { users: rows, studio_count: new Set(rows.map((r) => r.organization_id)).size };
}

/**
 * Deliver an announcement and mark it sent, in one transaction.
 *
 * Returns null when the announcement is not in a sendable state — which is
 * how a double-send is refused. The caller distinguishes "already sent" from
 * "does not exist" by looking it up first; here the guard is the WHERE clause
 * on the status update, so two concurrent sends cannot both win.
 *
 * @param {string} id
 * @param {object} pool pg pool
 * @param {object} actor { id, name }
 * @returns {Promise<object|null>} the updated announcement, or null
 */
async function send(id, pool, actor = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE, so a second request blocks here rather than resolving the
    // same audience and fanning out a duplicate copy to every studio.
    const { rows: [a] } = await client.query(
      `SELECT * FROM platform_announcements WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!a || a.status === 'sent' || a.status === 'cancelled') {
      await client.query('ROLLBACK');
      return null;
    }

    const { users, studio_count } = await resolveRecipients(a, client);

    // ref_id links every delivered copy back to the announcement, which is
    // what makes read receipts a COUNT rather than a second table.
    for (const u of users) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, body, link, ref_id)
         VALUES ($1, 'platform', $2, $3, $4, $5)`,
        [u.id, a.title, a.body, a.link || null, a.id]
      );
    }

    const { rows: [updated] } = await client.query(
      `UPDATE platform_announcements
          SET status = 'sent', sent_at = now(), recipient_count = $2, studio_count = $3,
              sent_by_name = $4, updated_at = now()
        WHERE id = $1 AND status <> 'sent'
        RETURNING *`,
      [id, users.length, studio_count, actor.name || null]
    );

    await client.query('COMMIT');
    logger.info({ id, recipients: users.length, studios: studio_count }, 'announcement sent');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dispatch everything whose scheduled time has arrived.
 *
 * Safe to call on a plain interval: each send is guarded by its own row lock
 * and status check, so an overlapping tick cannot double-deliver. Errors on one
 * announcement must not stop the rest — a malformed audience on one should not
 * hold up a maintenance notice.
 *
 * @returns {Promise<number>} how many went out
 */
async function dispatchDue(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM platform_announcements
      WHERE status = 'scheduled' AND scheduled_for <= now()
      ORDER BY scheduled_for`
  );
  let sent = 0;
  for (const r of rows) {
    try {
      if (await send(r.id, pool, { name: 'Scheduler' })) sent++;
    } catch (err) {
      logger.error({ err: err.message, id: r.id }, 'scheduled announcement failed to send');
    }
  }
  return sent;
}

module.exports = { audienceClause, resolveRecipients, send, dispatchDue };
