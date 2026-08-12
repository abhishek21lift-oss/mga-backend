'use strict';

/**
 * Self-serve trial signup, and the Command Centre queue that reviews it.
 *
 * "Start free" on the landing page used to go to the login screen, which is a
 * dead end for the one person it exists for: somebody without an account. This
 * gives them a way in that does not require a super-admin to build the studio
 * by hand first.
 *
 * An application is not an organisation — it is somebody asking for one, and
 * it has to survive being rejected. So it lands in `studio_registrations` and
 * nothing is provisioned until a human approves it. Approval then walks the
 * same path the Command Centre's own "create studio" already uses: an
 * organisation, a trainer, and an admin user, in one transaction.
 */

const {
  EMAIL_RE, audit, bcrypt, crypto, logger, pool, slugify, uniqueSlug,
} = require('./shared');

/** The trial the landing page advertises. Deliberately not the 7-day TRIAL_DAYS. */
const SELF_SERVE_TRIAL_DAYS = parseInt(process.env.SELF_SERVE_TRIAL_DAYS, 10) || 3;

/** Indian mobiles, entered by hand in every format under the sun. */
function normaliseMobile(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;
}

/**
 * What the applicant sent, cleaned, or a reason it cannot be accepted.
 *
 * Validated server-side in full rather than trusting the form: this endpoint is
 * unauthenticated and reachable by anyone.
 */
function validate(body) {
  const full_name = String(body.full_name || '').trim().replace(/\s+/g, ' ');
  const business_name = String(body.business_name || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const mobile = normaliseMobile(body.mobile);

  if (full_name.length < 2)      return { error: 'Please enter your full name.' };
  if (full_name.length > 120)    return { error: 'That name is too long.' };
  if (business_name.length < 2)  return { error: 'Please enter your business name.' };
  if (business_name.length > 120) return { error: 'That business name is too long.' };
  if (!EMAIL_RE.test(email))     return { error: 'Please enter a valid email address.' };
  if (email.length > 160)        return { error: 'That email address is too long.' };
  if (!mobile)                   return { error: 'Please enter a valid 10-digit mobile number.' };
  // Long enough to be worth hashing. Deliberately not a character-class maze:
  // those push people towards Password1! and a sticky note.
  if (password.length < 8)       return { error: 'Password must be at least 8 characters.' };
  if (password.length > 200)     return { error: 'That password is too long.' };

  return { value: { full_name, business_name, email, mobile, password } };
}

/** Columns the Command Centre may see. Never the password hash. */
const PUBLIC_COLUMNS = `
  id, full_name, business_name, mobile, email, status,
  organization_id, reviewed_at, reviewed_by, review_note,
  created_at, updated_at
`;

/* ── Public ──────────────────────────────────────────────────────────── */

/**
 * POST /api/registrations — anyone, no auth.
 *
 * Always answers as though it worked. An account-existence oracle here would
 * let anyone enumerate which studios are on the platform, so a duplicate is
 * logged for the operator and reported to the applicant the same way a genuine
 * new application is.
 */
async function create(req, res, next) {
  try {
    const { error, value } = validate(req.body || {});
    if (error) return res.status(400).json({ error: { code: 'INVALID', message: error } });

    // Same cost factor the users table uses, because this hash becomes that
    // row's password verbatim on approval. Hashed here rather than in SQL so
    // the plaintext never reaches the query text or the database log.
    const password_hash = await bcrypt.hash(value.password, 12);

    // One call, not three. This row is pre-tenant — organization_id stays NULL
    // until a super admin approves it — and 157 scopes studio_registrations
    // strictly to app.org_id, which an anonymous request never sets. So
    // app_tenant can neither insert the row nor run the two duplicate lookups
    // that used to sit here: both silently returned zero rows under RLS, which
    // failed OPEN and defeated the anti-enumeration response below.
    //
    // 162_public_registration_function.sql crosses that boundary once, for
    // this one insert, with organization_id and status written as literals so
    // neither can be supplied by the caller. See it for why an INSERT policy
    // cannot work here (INSERT ... RETURNING needs a SELECT policy, and any
    // SELECT policy wide enough would expose every applicant's password_hash).
    const { rows } = await pool.query(
      `SELECT registration_id, registration_status, created_at, was_duplicate
         FROM platform_submit_studio_registration($1,$2,$3,$4,$5)`,
      [value.full_name, value.business_name, value.mobile, value.email, password_hash]
    );
    const result = rows[0];

    if (result.was_duplicate) {
      logger.info({ email: value.email }, 'registration_duplicate_suppressed');
      return res.status(202).json({ data: { status: 'pending' } });
    }

    logger.info({ id: result.registration_id, email: value.email }, 'registration_received');
    res.status(201).json({
      data: {
        id: result.registration_id,
        full_name: value.full_name,
        business_name: value.business_name,
        mobile: value.mobile,
        email: value.email,
        status: result.registration_status,
        organization_id: null,
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
        created_at: result.created_at,
        updated_at: result.created_at,
      },
    });
  } catch (err) {
    // A race on the partial unique index means a second application landed
    // first. That is still "pending" from the applicant's point of view.
    if (err && err.code === '23505') return res.status(202).json({ data: { status: 'pending' } });
    next(err);
  }
}

/* ── Command Centre ──────────────────────────────────────────────────── */

/** GET /api/super-admin/registrations?status=pending */
async function list(req, res, next) {
  try {
    const status = String(req.query.status || 'pending');
    const params = [];
    let where = '';
    if (status !== 'all') { params.push(status); where = 'WHERE status = $1'; }

    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM studio_registrations ${where}
        ORDER BY created_at DESC LIMIT 200`,
      params
    );
    const { rows: counts } = await pool.query(
      `SELECT status, count(*)::int AS n FROM studio_registrations GROUP BY status`
    );
    res.json({
      data: rows,
      counts: counts.reduce((acc, r) => Object.assign(acc, { [r.status]: r.n }), {}),
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/super-admin/registrations/:id/approve
 *
 * Creates the studio and lets the applicant in with the password they already
 * chose. The whole thing is one transaction: a half-approved application is an
 * account nobody can log into and nobody can see is broken.
 */
async function approveHandler(req, res, next) {
  const client = await pool.connect();
  try {
    const { rows: appRows } = await client.query(
      'SELECT * FROM studio_registrations WHERE id = $1',
      [req.params.id]
    );
    const app = appRows[0];
    if (!app) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Application not found' } });
    if (app.status !== 'pending') {
      return res.status(409).json({
        error: { code: 'ALREADY_REVIEWED', message: `This application was already ${app.status}.` },
      });
    }
    if (!app.password_hash) {
      return res.status(409).json({
        error: { code: 'NO_CREDENTIAL', message: 'This application has no stored credential and cannot be approved.' },
      });
    }

    const { rows: clash } = await client.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [app.email]
    );
    if (clash.length) {
      return res.status(409).json({
        error: { code: 'EMAIL_TAKEN', message: 'A user with that email already exists.' },
      });
    }

    await client.query('BEGIN');

    const slug = await uniqueSlug(slugify(app.business_name), client);
    // The trial runs from THIS moment, not from when they applied — an
    // application that sat in the queue for two days must not arrive with one
    // day left on it.
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, status, subscription_status, trial_ends_at)
       VALUES ($1,$2,'active','trial', now() + ($3 || ' days')::interval)
       RETURNING *`,
      [app.business_name, slug, String(SELF_SERVE_TRIAL_DAYS)]
    );
    const org = orgRows[0];

    await client.query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,'trial_started',$2,$3,$4)`,
      [org.id, JSON.stringify({ days: SELF_SERVE_TRIAL_DAYS, source: 'self_serve_registration' }),
       req.user?.id || null, req.user?.name || null]
    );

    const { rows: trainerRows } = await client.query(
      `INSERT INTO trainers (name, email, mobile, organization_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [app.full_name, app.email, app.mobile, org.id]
    );

    const userId = crypto.randomUUID();
    // is_active TRUE, and the password is the hash they created at
    // registration — approval is the gate, so there is no second step and no
    // invitation link to notice.
    await client.query(
      `INSERT INTO users (id, name, email, password, role, trainer_id, organization_id, is_active)
       VALUES ($1,$2,$3,$4,'admin',$5,$6,TRUE)`,
      [userId, app.full_name, app.email, app.password_hash, trainerRows[0].id, org.id]
    );

    // The hash has been copied onto the user; it has no business living on in
    // the application row.
    await client.query(
      `UPDATE studio_registrations
          SET status = 'approved', organization_id = $2, password_hash = NULL,
              reviewed_at = now(), reviewed_by = $3, review_note = $4, updated_at = now()
        WHERE id = $1`,
      [app.id, org.id, req.user?.name || req.user?.email || 'Command Centre',
       String(req.body?.note || '').slice(0, 500) || null]
    );

    await client.query('COMMIT');

    await audit(req, 'registration_approved', 'studio_registration', app.id, {
      organization_id: org.id, email: app.email,
    }).catch(() => {});

    // Best-effort: a mail failure must not undo an approval that already
    // committed. The applicant can log in either way.
    try {
      const { sendWelcome } = require('../../../lib/email');
      if (typeof sendWelcome === 'function') {
        await sendWelcome({
          to: app.email, name: app.full_name, studioName: app.business_name,
          trialDays: SELF_SERVE_TRIAL_DAYS,
        });
      }
    } catch (mailErr) {
      logger.warn({ err: mailErr.message, id: app.id }, 'registration_welcome_email_failed');
    }

    res.json({ data: { id: app.id, status: 'approved', organization_id: org.id } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

/** POST /api/super-admin/registrations/:id/reject */
async function rejectHandler(req, res, next) {
  try {
    const note = String(req.body?.note || '').slice(0, 500) || null;
    const { rows } = await pool.query(
      `UPDATE studio_registrations
          SET status = 'rejected', password_hash = NULL, reviewed_at = now(),
              reviewed_by = $2, review_note = $3, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${PUBLIC_COLUMNS}`,
      [req.params.id, req.user?.name || req.user?.email || 'Command Centre', note]
    );
    if (!rows[0]) {
      return res.status(409).json({
        error: { code: 'NOT_PENDING', message: 'That application is no longer pending.' },
      });
    }
    await audit(req, 'registration_rejected', 'studio_registration', rows[0].id, { email: rows[0].email }).catch(() => {});
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
}

/* ── Router ──────────────────────────────────────────────────────────── */
//
// Every file in this directory exports an Express router and nothing else —
// superAdmin.routes.split.test.js asserts it. The unauthenticated half of this
// feature therefore lives in src/routes/registrations.js rather than being a
// second export here; the handlers below are shared between the two.
//
// Mounted inside the super-admin router, which already carries auth,
// requireSuperAdmin and the MFA gate, so these need no guard of their own.

const router = require('express').Router();
router.get('/registrations', list);

// Declared inline rather than as bare handler references: platform.guards
// reads each mutating route's body looking for `await audit(`, and a reference
// hides it. Both delegate immediately; the audit lives in the handler.
router.post('/registrations/:id/approve', async (req, res, next) => {
  await audit(req, 'registration_approve_attempt', 'studio_registration', req.params.id, {}).catch(() => {});
  return approveHandler(req, res, next);
});
router.post('/registrations/:id/reject', async (req, res, next) => {
  await audit(req, 'registration_reject_attempt', 'studio_registration', req.params.id, {}).catch(() => {});
  return rejectHandler(req, res, next);
});

module.exports = router;
module.exports.handlers = {
  create, list, approve: approveHandler, reject: rejectHandler,
  validate, normaliseMobile, SELF_SERVE_TRIAL_DAYS,
};
