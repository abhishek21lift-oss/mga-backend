// src/modules/bookings/bookings.service.js
// Class booking with capacity enforcement, waitlist, and cancellation policy.
// Uses transactions + row locking to prevent overbooking under concurrent load.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');
const cal = require('../../lib/google-calendar');
const logger = require('../../lib/logger');

const CANCEL_GRACE_HOURS = 2;     // free cancel if > 2h before start

/**
 * Push a booking to (or remove it from) the member's own Google Calendar.
 *
 * Two rules govern every call site below, and both matter:
 *
 * 1. ALWAYS AFTER COMMIT. Booking runs inside a transaction that holds a
 *    FOR UPDATE lock on the class_sessions row to prevent overbooking. A
 *    Google API round-trip inside that transaction would make every concurrent
 *    booker for that session queue behind an external network call — turning a
 *    lock held for microseconds into one held for hundreds of milliseconds,
 *    and coupling the studio's booking throughput to Google's latency.
 *
 * 2. NEVER FATAL. Calendar sync is a convenience; the booking is the product.
 *    google-calendar.js already swallows its own errors, and this adds a
 *    .catch() so a rejection can never surface as an unhandled promise and
 *    take the process down.
 *
 * The event goes to the MEMBER's calendar, not the acting user's — an admin
 * booking a class on someone's behalf should not have it appear in their own
 * diary. Members without a login simply have nothing to sync to.
 */
function syncBookingToCalendar(action, memberId, bookingId) {
  if (!memberId || !bookingId || !cal.isConfigured()) return;

  (async () => {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE member_id = $1 AND deleted_at IS NULL LIMIT 1',
      [memberId]
    );
    const userId = rows[0]?.id;
    if (!userId) return;

    if (action === 'create') await cal.createBookingEvent(userId, bookingId);
    else await cal.deleteBookingEvent(userId, bookingId);
  })().catch((err) => {
    logger.warn({ err: err.message, action, bookingId }, 'calendar sync failed (non-critical)');
  });
}

/**
 * Book a class session for a member.
 * Atomic: locks the session row, counts confirmed bookings, decides confirmed vs waitlist.
 */
async function book({ session_id, member_id }, ctx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the session row to serialize concurrent bookers
    const sessionRes = await client.query(
      `SELECT id, capacity, starts_at, status, template_id
       FROM class_sessions WHERE id = $1 FOR UPDATE`,
      [session_id]
    );
    if (sessionRes.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Class session not found');
    const session = sessionRes.rows[0];
    if (session.status !== 'scheduled') throw new HttpError(400, 'BAD_STATE', 'Session is not scheduled');
    if (new Date(session.starts_at) < new Date()) throw new HttpError(400, 'BAD_STATE', 'Session already started');

    // 2. Verify no existing booking
    const existing = await client.query(
      `SELECT id, status FROM bookings WHERE session_id = $1 AND member_id = $2`,
      [session_id, member_id]
    );
    if (existing.rows.length > 0 && ['confirmed','waitlist'].includes(existing.rows[0].status)) {
      throw new HttpError(409, 'ALREADY_BOOKED', 'You already have a booking for this session');
    }

    // 3. Check active membership.
    // Qualify every column with mm./p. — `id`, `classes_used`, `plan_id` exist
    // on both tables and Postgres throws "column reference is ambiguous" if
    // they're left unqualified.
    const mm = await client.query(
      `SELECT mm.id, mm.classes_used, mm.plan_id, p.included_classes
       FROM member_memberships mm
       JOIN plans p ON p.id = mm.plan_id
       WHERE mm.member_id = $1 AND mm.status = 'active'
         AND mm.start_date <= CURRENT_DATE AND mm.end_date >= CURRENT_DATE
       ORDER BY mm.end_date DESC LIMIT 1`,
      [member_id]
    );
    if (mm.rows.length === 0) throw new HttpError(402, 'NO_MEMBERSHIP', 'Active membership required');
    const membership = mm.rows[0];

    if (membership.included_classes !== null && membership.classes_used >= membership.included_classes) {
      throw new HttpError(402, 'CLASSES_EXHAUSTED', 'No class credits left on your plan');
    }

    // 4. Count confirmed bookings (with the lock from step 1, this is safe)
    const countRes = await client.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE session_id = $1 AND status = 'confirmed'`,
      [session_id]
    );
    const confirmed = parseInt(countRes.rows[0].n);

    let status, position = null;
    if (confirmed < session.capacity) {
      status = 'confirmed';
    } else {
      status = 'waitlist';
      const wlRes = await client.query(
        `SELECT COALESCE(MAX(position),0) + 1 AS pos FROM bookings WHERE session_id = $1 AND status = 'waitlist'`,
        [session_id]
      );
      position = parseInt(wlRes.rows[0].pos);
    }

    // 5. Insert booking
    const bookingRes = await client.query(
      `INSERT INTO bookings (session_id, member_id, membership_id, status, position)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [session_id, member_id, membership.id, status, position]
    );
    const booking = bookingRes.rows[0];

    // 6. If confirmed and plan has limited classes, increment usage
    if (status === 'confirmed' && membership.included_classes !== null) {
      await client.query(
        `UPDATE member_memberships SET classes_used = classes_used + 1 WHERE id = $1`,
        [membership.id]
      );
    }

    // 7. Audit + notification (queued; not awaited here in real impl).
    // Previously targeted a differently-shaped legacy table and threw on
    // every call (unreached in practice — this module has no frontend
    // caller). Fixed to the table every other audited write in the app
    // uses, on the same client/transaction so a rollback also rolls this
    // back.
    await client.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, new_data, organization_id)
       VALUES ($1,$2,'booking.create','booking',$3,$4,$5)`,
      [ctx.user_id, ctx.user_name || null, booking.id, JSON.stringify(booking), ctx.organization_id || null]
    );

    await client.query('COMMIT');

    // Only confirmed bookings get a calendar entry — a waitlist place is not
    // an appointment, and putting one in someone's diary would be a lie. It
    // gets its event later, if and when the waitlist promotes it in cancel().
    if (booking.status === 'confirmed') {
      syncBookingToCalendar('create', member_id, booking.id);
    }
    return booking;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancel a booking. Enforces grace-period policy and promotes from waitlist.
 */
async function cancel(bookingId, { reason } = {}, ctx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT b.*, cs.starts_at, cs.capacity, mm.plan_id, p.included_classes
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.session_id
       LEFT JOIN member_memberships mm ON mm.id = b.membership_id
       LEFT JOIN plans p ON p.id = mm.plan_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId]
    );
    if (r.rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    const b = r.rows[0];

    // Authorization
    if (ctx.role === 'member' && b.member_id !== ctx.member_id) {
      throw new HttpError(403, 'FORBIDDEN', 'Not your booking');
    }
    if (b.status === 'cancelled') throw new HttpError(400, 'ALREADY_CANCELLED', 'Already cancelled');

    const hoursUntil = (new Date(b.starts_at) - new Date()) / 36e5;
    const inGrace = hoursUntil >= CANCEL_GRACE_HOURS;

    await client.query(
      `UPDATE bookings SET status='cancelled', cancelled_at=NOW(), cancellation_reason=$2 WHERE id = $1`,
      [bookingId, reason || null]
    );

    // Refund credit if cancelled in grace period and was confirmed and uses credits
    if (b.status === 'confirmed' && inGrace && b.included_classes !== null) {
      await client.query(
        `UPDATE member_memberships SET classes_used = GREATEST(classes_used - 1, 0) WHERE id = $1`,
        [b.membership_id]
      );
    }

    // Promote first waitlist booking if a confirmed slot freed up
    let promoted = null;
    if (b.status === 'confirmed') {
      const promote = await client.query(
        `SELECT id, member_id, membership_id, position FROM bookings
         WHERE session_id = $1 AND status='waitlist'
         ORDER BY position ASC LIMIT 1 FOR UPDATE`,
        [b.session_id]
      );
      if (promote.rows.length > 0) {
        promoted = promote.rows[0];
        const promotedPos = promote.rows[0].position;
        await client.query(
          `UPDATE bookings SET status='confirmed', position=NULL WHERE id = $1`,
          [promote.rows[0].id]
        );
        // Reshuffle waitlist positions (decrement all above the promoted slot)
        await client.query(
          `UPDATE bookings SET position = position - 1
           WHERE session_id = $1 AND status='waitlist' AND position > $2`,
          [b.session_id, promotedPos]
        );
      }
    }

    await client.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, organization_id)
       VALUES ($1,$2,'booking.cancel','booking',$3,$4)`,
      [ctx.user_id, ctx.user_name || null, bookingId, ctx.organization_id || null]
    );
    await client.query('COMMIT');

    // Remove the cancelled member's event. Safe even if there was never one
    // (waitlist bookings never got one) — deleteBookingEvent no-ops when it
    // finds no stored google_event_id.
    syncBookingToCalendar('delete', b.member_id, bookingId);

    // Someone promoted off the waitlist now genuinely has a class to attend,
    // so they get the event the cancelled member just lost. Without this, a
    // promotion is invisible in their calendar and they miss the session.
    if (promoted) {
      syncBookingToCalendar('create', promoted.member_id, promoted.id);
    }

    return { id: bookingId, status: 'cancelled', refunded: inGrace };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check in (member arrives at the gym).
 */
async function checkIn(bookingId, { method = 'manual' }, _ctx) {
  const r = await pool.query(
    `UPDATE bookings SET status='attended', checked_in_at = NOW(), check_in_method = $2
     WHERE id = $1 AND status = 'confirmed'
     RETURNING *`,
    [bookingId, method]
  );
  if (r.rows.length === 0) throw new HttpError(400, 'BAD_STATE', 'Booking not confirmed or already attended');

  // Mirror to attendance table
  const b = r.rows[0];
  await pool.query(
    `INSERT INTO attendance (type, ref_id, member_id, booking_id, branch_id, date, check_in, status, check_in_method)
     VALUES ('client', $1, $1, $2, COALESCE($4, 'br-main'), CURRENT_DATE, NOW()::time, 'present', $3)
     ON CONFLICT (type, ref_id, date) DO UPDATE SET check_in = EXCLUDED.check_in, status = 'present'`,
    [b.member_id, b.id, method, process.env.BRANCH_ID || null]
  );
  return b;
}

async function listForMember(memberId, { from, to, status } = {}) {
  const params = [memberId];
  const where = [`b.member_id = $1`];
  if (from)   { params.push(from);   where.push(`cs.starts_at >= $${params.length}`); }
  if (to)     { params.push(to);     where.push(`cs.starts_at <= $${params.length}`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.position, b.booked_at, b.checked_in_at,
            cs.id AS session_id, cs.starts_at, cs.ends_at,
            ct.name AS class_name, ct.color, t.name AS trainer_name
     FROM bookings b
     JOIN class_sessions cs ON cs.id = b.session_id
     JOIN class_templates ct ON ct.id = cs.template_id
     LEFT JOIN trainers t ON t.id = cs.trainer_id
     WHERE ${where.join(' AND ')}
     ORDER BY cs.starts_at DESC LIMIT 200`,
    params
  );
  return rows;
}

module.exports = { book, cancel, checkIn, listForMember };
