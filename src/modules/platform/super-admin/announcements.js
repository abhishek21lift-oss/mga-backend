'use strict';
// Platform announcements — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, pool,
} = require('./shared');
const announcements = require('../../../lib/announcements');

const TITLE_MAX = 140;
const BODY_MAX = 4000;
const SEVERITIES = ['info', 'success', 'warning', 'critical'];
const AUDIENCES = ['all', 'plan', 'status', 'studios'];
const ANNOUNCEMENT_ROLES = ['admin', 'manager', 'trainer', 'member'];

/** Shared by create and update; returns { error } or { value }. */
function validateAnnouncement(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);

  if (has('title') || !partial) {
    const t = String(body?.title ?? '').trim();
    if (!t) return { error: 'A title is required.' };
    if (t.length > TITLE_MAX) return { error: `Title must be ${TITLE_MAX} characters or fewer.` };
    v.title = t;
  }
  if (has('body') || !partial) {
    const b = String(body?.body ?? '').trim();
    if (!b) return { error: 'A message is required.' };
    if (b.length > BODY_MAX) return { error: `Message must be ${BODY_MAX} characters or fewer.` };
    v.body = b;
  }
  if (has('severity')) {
    if (!SEVERITIES.includes(body.severity)) return { error: `severity must be one of ${SEVERITIES.join(', ')}` };
    v.severity = body.severity;
  }
  if (has('link')) {
    const l = String(body.link ?? '').trim();
    // Relative paths only. An absolute URL in a platform notice is a phishing
    // vector waiting for whoever gets write access to this table next.
    if (l && !l.startsWith('/')) return { error: 'link must be an in-app path starting with /' };
    v.link = l || null;
  }
  if (has('audience')) {
    if (!AUDIENCES.includes(body.audience)) return { error: `audience must be one of ${AUDIENCES.join(', ')}` };
    v.audience = body.audience;
  }
  for (const [key, field] of [['audience_plans', 'plans'], ['audience_statuses', 'statuses'], ['audience_org_ids', 'studios']]) {
    if (has(key)) {
      if (!Array.isArray(body[key])) return { error: `${key} must be an array` };
      v[key] = body[key].map(String);
      void field;
    }
  }
  if (has('audience_roles')) {
    if (!Array.isArray(body.audience_roles) || !body.audience_roles.length) {
      return { error: 'audience_roles must be a non-empty array' };
    }
    const bad = body.audience_roles.filter((r) => !ANNOUNCEMENT_ROLES.includes(r));
    if (bad.length) return { error: `Unknown role(s): ${bad.join(', ')}` };
    v.audience_roles = body.audience_roles;
  }

  // A targeted audience with an empty list would silently reach nobody, which
  // looks identical to a successful send.
  const aud = v.audience ?? (partial ? undefined : 'all');
  const listFor = { plan: 'audience_plans', status: 'audience_statuses', studios: 'audience_org_ids' }[aud];
  if (listFor && has(listFor) && !v[listFor].length) {
    return { error: `Selecting "${aud}" requires at least one entry.` };
  }
  if (listFor && !partial && !v[listFor]?.length) {
    return { error: `Selecting "${aud}" requires at least one entry.` };
  }

  return { value: v };
}

// ── GET /announcements ───────────────────────────────────────────────────────
// With live read receipts. Counted from the delivered notifications rather than
// stored, because `is_read` on each copy IS the receipt and a stored tally
// would need updating every time somebody opened their bell.
router.get('/announcements', async (req, res, next) => {
  try {
    const params = [];
    let clause = '';
    if (req.query.status) { params.push(req.query.status); clause = `WHERE a.status = $1`; }

    const { rows } = await pool.query(
      `SELECT a.*,
              (SELECT count(*)::int FROM notifications n WHERE n.ref_id = a.id::text) AS delivered,
              (SELECT count(*)::int FROM notifications n WHERE n.ref_id = a.id::text AND n.is_read) AS read_count
         FROM platform_announcements a
         ${clause}
         ORDER BY COALESCE(a.sent_at, a.scheduled_for, a.created_at) DESC
         LIMIT 200`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /announcements ──────────────────────────────────────────────────────
// Always creates a draft. Scheduling and sending are separate, explicit acts —
// a create that could also deliver would make an irreversible action reachable
// by a mistyped request body.
router.post('/announcements', async (req, res, next) => {
  try {
    const { error, value } = validateAnnouncement(req.body);
    if (error) return res.status(400).json({ error: { code: 'VALIDATION', message: error } });

    const { rows } = await pool.query(
      `INSERT INTO platform_announcements
         (title, body, severity, link, audience, audience_plans, audience_statuses,
          audience_org_ids, audience_roles, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11)
       RETURNING *`,
      [value.title, value.body, value.severity || 'info', value.link || null,
       value.audience || 'all', value.audience_plans || null, value.audience_statuses || null,
       value.audience_org_ids || null, value.audience_roles || ['admin', 'manager'],
       req.user?.id || null, req.user?.name || null]
    );

    await audit(req, 'announcement_created', 'announcement', rows[0].id,
      { title: value.title, audience: rows[0].audience });
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /announcements/:id ─────────────────────────────────────────────────
router.patch('/announcements/:id', async (req, res, next) => {
  try {
    const { rows: [existing] } = await pool.query(
      'SELECT * FROM platform_announcements WHERE id = $1', [req.params.id]
    );
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Announcement not found' } });
    if (existing.status === 'sent') {
      // Editing after delivery would make the record disagree with what the
      // studios actually received — the copy in their bell does not change.
      return res.status(400).json({ error: { code: 'ALREADY_SENT', message: 'A sent announcement cannot be edited.' } });
    }

    const { error, value } = validateAnnouncement(req.body, { partial: true });
    if (error) return res.status(400).json({ error: { code: 'VALIDATION', message: error } });
    if (!Object.keys(value).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }

    const cols = Object.keys(value);
    const casts = { audience_org_ids: '::uuid[]' };
    const { rows } = await pool.query(
      `UPDATE platform_announcements
          SET ${cols.map((c, i) => `${c} = $${i + 2}${casts[c] || ''}`).join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, ...cols.map((c) => value[c])]
    );

    await audit(req, 'announcement_updated', 'announcement', req.params.id, { changed: cols });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /announcements/:id/preview ──────────────────────────────────────────
// Who would receive this, right now. Uses the SAME resolver as the send, so
// the number an operator confirms is the number that goes out.
router.post('/announcements/:id/preview', async (req, res, next) => {
  try {
    const { rows: [a] } = await pool.query('SELECT * FROM platform_announcements WHERE id = $1', [req.params.id]);
    if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Announcement not found' } });

    const { users, studio_count } = await announcements.resolveRecipients(a, pool);
    res.json({
      data: {
        recipient_count: users.length,
        studio_count,
        // A short sample, because "412 recipients" is not something an operator
        // can sanity-check but "Iron House — Priya (admin)" is.
        sample: users.slice(0, 10).map((u) => ({
          name: u.name, role: u.role, organization_name: u.organization_name,
        })),
      },
    });
  } catch (err) { next(err); }
});

// ── POST /announcements/:id/send ─────────────────────────────────────────────
router.post('/announcements/:id/send', async (req, res, next) => {
  try {
    const { rows: [a] } = await pool.query('SELECT * FROM platform_announcements WHERE id = $1', [req.params.id]);
    if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Announcement not found' } });
    if (a.status === 'sent') {
      return res.status(400).json({ error: { code: 'ALREADY_SENT', message: 'This announcement has already been sent.' } });
    }

    const sent = await announcements.send(req.params.id, pool, req.user || {});
    if (!sent) {
      // Lost the race to a concurrent send, or it was cancelled in between.
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'The announcement changed while sending. Reload and try again.' } });
    }

    await audit(req, 'announcement_sent', 'announcement', sent.id, {
      title: sent.title, recipients: sent.recipient_count, studios: sent.studio_count,
      audience: sent.audience,
    });
    res.json({ data: sent });
  } catch (err) { next(err); }
});

// ── POST /announcements/:id/schedule ─────────────────────────────────────────
router.post('/announcements/:id/schedule', async (req, res, next) => {
  try {
    const when = new Date(req.body?.scheduled_for);
    if (isNaN(when.getTime())) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'scheduled_for is not a valid date' } });
    }
    if (when.getTime() <= Date.now()) {
      // A time in the past would fire on the very next dispatcher tick, which
      // is a send dressed up as a schedule.
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'scheduled_for must be in the future' } });
    }

    const { rows } = await pool.query(
      `UPDATE platform_announcements
          SET status = 'scheduled', scheduled_for = $2, updated_at = now()
        WHERE id = $1 AND status IN ('draft', 'scheduled')
        RETURNING *`,
      [req.params.id, when.toISOString()]
    );
    if (!rows[0]) {
      return res.status(400).json({ error: { code: 'NOT_SCHEDULABLE', message: 'Only a draft or scheduled announcement can be scheduled.' } });
    }

    await audit(req, 'announcement_scheduled', 'announcement', req.params.id,
      { scheduled_for: when.toISOString() });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /announcements/:id/cancel ───────────────────────────────────────────
// Only ever stops a scheduled send. A sent announcement cannot be recalled and
// the API says so rather than pretending.
router.post('/announcements/:id/cancel', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE platform_announcements SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status = 'scheduled' RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(400).json({ error: { code: 'NOT_CANCELLABLE', message: 'Only a scheduled announcement can be cancelled.' } });
    }
    await audit(req, 'announcement_cancelled', 'announcement', req.params.id, { title: rows[0].title });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /announcements/:id ────────────────────────────────────────────────
// Drafts and cancelled ones only. Deleting a sent announcement would orphan the
// notifications already in studios' bells from the record explaining them.
router.delete('/announcements/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM platform_announcements WHERE id = $1 AND status IN ('draft', 'cancelled') RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(400).json({ error: { code: 'NOT_DELETABLE', message: 'Only a draft or cancelled announcement can be deleted.' } });
    }
    await audit(req, 'announcement_deleted', 'announcement', req.params.id, { title: rows[0].title });
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY CENTRE
//
//  Who is trying to get in, who succeeded, what is exposed.
//
//  Read-only. Every action an operator might want to take from here — force
//  logout, reset MFA, deactivate — already exists in Admin Management and is
//  already audited there. Duplicating them would give the same act two audit
//  shapes and two places to get the permission checks right.
//
//  Deliberately NOT here: account lockout. Locking accounts after N failures
//  changes how the Admin Studio behaves for real users and can shut a studio
//  out of its own product during an attack that was never going to succeed.
//  That is a product decision, not a side effect of adding observability.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
