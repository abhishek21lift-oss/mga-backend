'use strict';
// Admin invitations — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, deliverInvitation, frontendUrl, invitations, pool, smtpConfigured,
} = require('./shared');
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN INVITATIONS
//
//  Creating a studio used to mean the operator typed a password and passed it
//  to the customer out of band. That put a human-chosen credential into a
//  chat app and left the operator permanently knowing it. Invitations replace
//  that: the account is created with no usable password and the admin sets
//  their own through a single-use link.
//
//  The raw token is never stored — only its SHA-256. One consequence is worth
//  stating plainly because it shapes the API: the platform CANNOT show an
//  operator a link it already sent. "Copy link" therefore ISSUES A NEW ONE and
//  invalidates the old, and says so.
// ═══════════════════════════════════════════════════════════════════════════


// ── GET /invitations ─────────────────────────────────────────────────────────
router.get('/invitations', async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.org_id) { params.push(req.query.org_id); where.push(`i.organization_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).toLowerCase()}%`);
      where.push(`(LOWER(i.email) LIKE $${params.length} OR LOWER(i.studio_name) LIKE $${params.length} OR LOWER(i.owner_name) LIKE $${params.length})`);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);

    const { rows } = await pool.query(
      `SELECT i.*, o.name AS org_name
         FROM admin_invitations i
         JOIN organizations o ON o.id = i.organization_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY i.created_at DESC
        LIMIT ${limit}`,
      params
    );

    // Filtering by status happens here rather than in SQL because 'expired' is
    // derived from the clock, not stored — a WHERE status = 'expired' would
    // miss every invitation that lapsed since it was last written.
    const wanted = req.query.status ? String(req.query.status) : null;
    const data = rows.map(invitations.present).filter((r) => !wanted || r.status === wanted);

    const counts = data.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    res.json({ data, counts, smtp_configured: smtpConfigured() });
  } catch (err) { next(err); }
});

/** Loads an invitation and the studio it belongs to, or null. */
async function loadInvitation(id) {
  const { rows } = await pool.query(
    `SELECT i.*, o.name AS org_name FROM admin_invitations i
       JOIN organizations o ON o.id = i.organization_id
      WHERE i.id = $1`, [id]
  );
  return rows[0] || null;
}

/**
 * Issue a fresh token for an account, superseding whatever was outstanding.
 * Shared by resend and copy-link so both go through the same rate limit and
 * the same invalidation — a "copy link" that skipped either would be a way
 * around both.
 */
async function reissue(inv, req) {
  const limit = await invitations.withinRateLimit(inv.user_id);
  if (!limit.ok) {
    return { error: {
      status: 429,
      code: 'RATE_LIMITED',
      message: `That account has already had ${limit.used} invitations in the last ${limit.windowHours} hour. Try again later.`,
    } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Supersede first: a resend exists because the previous link may have gone
    // astray, so leaving it live would defeat the reason for resending.
    await invitations.supersedeOpen(inv.user_id, { client });
    const made = await invitations.create({
      client,
      userId: inv.user_id,
      organizationId: inv.organization_id,
      email: inv.email,
      ownerName: inv.owner_name,
      studioName: inv.studio_name || inv.org_name,
      req,
    });
    await client.query('COMMIT');
    return { invitation: made.invitation, token: made.token };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /invitations/:id/resend ─────────────────────────────────────────────
router.post('/invitations/:id/resend', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.id);
    if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
    if (invitations.effectiveStatus(inv) === 'activated') {
      return res.status(409).json({ error: { code: 'ALREADY_ACTIVATED', message: 'That studio has already activated. Resending would do nothing.' } });
    }
    if (!smtpConfigured()) {
      return res.status(503).json({ error: { code: 'SMTP_NOT_CONFIGURED', message: 'Email is not configured on this deploy.' } });
    }

    const out = await reissue(inv, req);
    if (out.error) return res.status(out.error.status).json({ error: { code: out.error.code, message: out.error.message } });

    const outcome = await deliverInvitation(out.invitation, out.token);
    await audit(req, 'admin_invitation_resent', 'admin_invitation', out.invitation.id, {
      email: inv.email, organization_id: inv.organization_id,
      superseded: inv.id, sent: outcome.sent, error: outcome.error,
    });

    if (!outcome.sent) {
      return res.status(502).json({ error: { code: 'SEND_FAILED', message: outcome.error || 'The email could not be sent.' } });
    }
    res.json({ data: invitations.present({ ...out.invitation, status: 'sent' }) });
  } catch (err) { next(err); }
});

// ── POST /invitations/:id/link ───────────────────────────────────────────────
// A POST, not a GET, because it MUTATES: there is no stored link to read, so
// this mints a new one and kills the old. A GET implying otherwise would be a
// lie about a security-relevant side effect.
router.post('/invitations/:id/link', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.id);
    if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
    if (invitations.effectiveStatus(inv) === 'activated') {
      return res.status(409).json({ error: { code: 'ALREADY_ACTIVATED', message: 'That studio has already activated.' } });
    }

    const out = await reissue(inv, req);
    if (out.error) return res.status(out.error.status).json({ error: { code: out.error.code, message: out.error.message } });

    await audit(req, 'admin_invitation_link_issued', 'admin_invitation', out.invitation.id, {
      email: inv.email, organization_id: inv.organization_id, superseded: inv.id,
    });

    // The one place a raw token leaves the server outside an email. It goes to
    // an authenticated platform operator over TLS and is not stored.
    res.json({
      data: {
        url: frontendUrl(`/auth/set-password?token=${out.token}`),
        expires_at: out.invitation.expires_at,
        invitation: invitations.present(out.invitation),
      },
    });
  } catch (err) { next(err); }
});

// ── POST /invitations/:id/cancel ─────────────────────────────────────────────
router.post('/invitations/:id/cancel', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.id);
    if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });

    const cancelled = await invitations.cancel(req.params.id);
    if (!cancelled) {
      return res.status(409).json({
        error: { code: 'NOT_OPEN', message: `That invitation is ${invitations.effectiveStatus(inv)} and cannot be cancelled.` },
      });
    }
    await audit(req, 'admin_invitation_cancelled', 'admin_invitation', cancelled.id, {
      email: inv.email, organization_id: inv.organization_id,
    });
    res.json({ data: invitations.present(cancelled) });
  } catch (err) { next(err); }
});

// ── GET /invitations/:id/events ──────────────────────────────────────────────
// The audit trail for one invitation: who issued it, when it was sent, opened,
// activated, and every failure in between.
router.get('/invitations/:id/events', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.id);
    if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } });

    // Built from the row's own timestamps rather than a separate event table:
    // every one of these is already recorded, and a second store would be one
    // more thing to keep in step with the first.
    const events = [
      { at: inv.created_at, label: 'Invitation created', by: inv.created_by_name, meta: inv.created_ip },
      inv.sent_at && { at: inv.sent_at, label: `Email sent to ${inv.email}`, by: null, meta: inv.send_attempts > 1 ? `${inv.send_attempts} attempts` : null },
      inv.opened_at && { at: inv.opened_at, label: 'Email opened', by: null, meta: null },
      inv.activated_at && { at: inv.activated_at, label: 'Password set — account activated', by: inv.owner_name, meta: inv.activated_ip },
      inv.cancelled_at && { at: inv.cancelled_at, label: 'Invitation cancelled or superseded', by: null, meta: null },
      inv.last_error && { at: inv.updated_at, label: 'Delivery failed', by: null, meta: inv.last_error },
    ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at));

    const { rows: logRows } = await pool.query(
      `SELECT action, user_name, ip_address, user_agent, created_at
         FROM activity_log
        WHERE entity_type = 'admin_invitation' AND entity_id = $1
        ORDER BY created_at`,
      [req.params.id]
    );

    res.json({
      data: {
        invitation: invitations.present(inv),
        events,
        audit: logRows,
        created_user_agent: inv.created_user_agent,
        activated_user_agent: inv.activated_user_agent,
      },
    });
  } catch (err) { next(err); }
});


module.exports = router;
