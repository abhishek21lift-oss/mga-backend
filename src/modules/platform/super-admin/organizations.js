'use strict';
// Studios and their login accounts — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  EMAIL_RE, TENANT_ROLES, TRIAL_DAYS, audit, bcrypt, crypto, deliverInvitation, detectLogoType, invalidateUserCache, invitations, logger, logoUpload, pool, saveFile, sendPasswordReset, slugify, smtpConfigured, uniqueSlug,
} = require('./shared');
// ── GET /organizations ───────────────────────────────────────────────────────
router.get('/organizations', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.status, o.created_at,
             (SELECT count(*) FROM users u    WHERE u.organization_id = o.id AND u.deleted_at IS NULL)    AS user_count,
             (SELECT count(*) FROM trainers t WHERE t.organization_id = o.id AND t.deleted_at IS NULL)     AS trainer_count,
             (SELECT count(*) FROM pt_clients c
                 JOIN trainers t ON t.id = c.trainer_id
                WHERE t.organization_id = o.id AND c.deleted_at IS NULL)                                   AS client_count
        FROM organizations o
       ORDER BY o.created_at DESC`);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /organizations/:id ────────────────────────────────────────────────────
router.get('/organizations/:id', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const { rows: users } = await pool.query(
      `SELECT id, name, email, role, trainer_id, is_active, last_login, created_at
         FROM users WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [req.params.id]
    );
    res.json({ data: { ...orgs[0], users } });
  } catch (err) { next(err); }
});

// ── POST /organizations ───────────────────────────────────────────────────────
// Creates a tenant workspace in one transaction: the organization, its owner
// trainer record, and the trainer's login (role='admin' — full control of
// their own isolated workspace; the platform god is role='super_admin').
router.post('/organizations', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgName = String(req.body.name || '').trim();
    const trainerName = String(req.body.trainer_name || orgName).trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const mobile = String(req.body.mobile || '').trim();
    const password = String(req.body.password || '');

    // Two ways to create a studio, and the DEFAULT changed.
    //
    // Passing a password keeps the original behaviour exactly: the account is
    // active immediately with that password. It is kept as the escape hatch
    // for when SMTP is down and a studio has to be stood up now.
    //
    // Omitting it — which is what the UI now does — creates the account with
    // NO usable password and emails an invitation instead. That is the
    // difference between an operator who permanently knows a customer's
    // credentials and one who never does.
    const useInvite = password === '';

    if (!orgName) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Organization name is required' } });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid login email is required' } });
    if (!useInvite && password.length < 8) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    }
    if (useInvite && !smtpConfigured()) {
      // Refuse rather than create an account nobody can ever claim. The
      // operator can still set a password explicitly to get unblocked.
      return res.status(503).json({
        error: {
          code: 'SMTP_NOT_CONFIGURED',
          message: 'Email is not configured on this deploy, so an invitation cannot be sent. Set a password to create the studio without one.',
        },
      });
    }

    const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That login email is already in use' } });

    const slug = await uniqueSlug(slugify(orgName));
    // An invited account still gets a bcrypt hash, of a value nobody knows and
    // nobody keeps. Not an empty string and not NULL: either would be one
    // forgotten is_active check away from a login bypass, whereas a hash of
    // 32 random bytes is simply unguessable.
    const hashed = await bcrypt.hash(
      useInvite ? crypto.randomBytes(32).toString('hex') : password, 12
    );
    const userId = crypto.randomUUID();

    await client.query('BEGIN');
    // New studios get a 7-day free trial with all premium features unlocked.
    // organizations.status stays 'active' (that column is the super-admin hard
    // on/off switch); subscription_status drives the billing lifecycle.
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, status, subscription_status, trial_ends_at)
       VALUES ($1,$2,'active','trial', now() + ($3 || ' days')::interval)
       RETURNING *`,
      [orgName, slug, String(TRIAL_DAYS)]
    );
    const org = orgRows[0];
    await client.query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,'trial_started',$2,$3,$4)`,
      [org.id, JSON.stringify({ days: TRIAL_DAYS }), req.user?.id || null, req.user?.name || null]
    );
    const { rows: trainerRows } = await client.query(
      `INSERT INTO trainers (name, email, mobile, organization_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [trainerName, email, mobile || null, org.id]
    );
    const trainerId = trainerRows[0].id;
    await client.query(
      `INSERT INTO users (id, name, email, password, role, trainer_id, organization_id, is_active)
       VALUES ($1,$2,$3,$4,'admin',$5,$6,$7)`,
      // is_active FALSE for an invited admin. This is the actual lock — the
      // auth middleware refuses inactive users — so an unclaimed studio cannot
      // be logged into even by someone who guesses the random password.
      [userId, trainerName, email, hashed, trainerId, org.id, !useInvite]
    );

    // The invitation row is created INSIDE the same transaction. A studio that
    // committed without one is an account no one can ever claim and no one can
    // see is broken.
    let inviteToken = null;
    let invitation = null;
    if (useInvite) {
      const made = await invitations.create({
        client, userId, organizationId: org.id, email,
        ownerName: trainerName, studioName: orgName, req,
      });
      invitation = made.invitation;
      inviteToken = made.token;
    }

    await client.query('COMMIT');

    await audit(req, 'org_created', 'organization', org.id, {
      name: orgName, slug, owner_email: email, onboarding: useInvite ? 'invitation' : 'password',
    });

    // Sending happens after the commit: an SMTP call inside a transaction
    // holds a database connection open for the length of a network round trip,
    // and a send that succeeded followed by a rollback would deliver a link to
    // an account that does not exist.
    let emailSent = false;
    let emailError = null;
    if (useInvite) {
      const outcome = await deliverInvitation(invitation, inviteToken);
      emailSent = outcome.sent;
      emailError = outcome.error;
    }

    res.status(201).json({
      data: {
        organization: org,
        owner: { id: userId, name: trainerName, email, role: 'admin', trainer_id: trainerId },
        onboarding: useInvite ? 'invitation' : 'password',
        invitation: invitation ? invitations.present({ ...invitation, status: emailSent ? 'sent' : invitation.status }) : null,
        email_sent: emailSent,
        // Surfaced, not swallowed: the studio exists either way, and only the
        // operator can resend. A silent failure leaves everyone believing the
        // email went out.
        email_error: emailError,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── PATCH /organizations/:id ──────────────────────────────────────────────────
// Rename and/or change status. Suspending an org deactivates all its logins
// and revokes their sessions; reactivating restores them.
router.patch('/organizations/:id', async (req, res, next) => {
  try {
    const { name, status } = req.body;
    if (status && !['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: "status must be 'active' or 'suspended'" } });
    }

    const sets = [];
    const params = [req.params.id];
    if (name !== undefined)   { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
    if (status !== undefined) { params.push(status);              sets.push(`status = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    if (status === 'suspended') {
      await pool.query(
        `UPDATE users SET is_active = false, token_version = token_version + 1 WHERE organization_id = $1`,
        [req.params.id]
      );
      invalidateUserCache();
    } else if (status === 'active') {
      await pool.query(
        `UPDATE users SET is_active = true, token_version = token_version + 1 WHERE organization_id = $1`,
        [req.params.id]
      );
      invalidateUserCache();
    }

    await audit(req, 'org_updated', 'organization', req.params.id, { name, status });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /users/:id ──────────────────────────────────────────────────────────
// Edit a tenant login: name, email, role, and/or activate/deactivate. Changing
// role or is_active bumps token_version so the account re-authenticates with its
// new powers (and a deactivation immediately revokes existing sessions).
// Platform (super_admin) accounts cannot be edited through this portal.
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (existing[0].role === 'super_admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform accounts cannot be edited here' } });
    }

    const { name, email, role, is_active } = req.body;
    const sets = [];
    const params = [req.params.id];
    let securityChange = false;

    if (name !== undefined) {
      const v = String(name).trim();
      if (!v) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Name cannot be empty' } });
      params.push(v); sets.push(`name = $${params.length}`);
    }
    if (email !== undefined) {
      const v = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(v)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid email is required' } });
      const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2', [v, req.params.id]);
      if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That email is already in use' } });
      params.push(v); sets.push(`email = $${params.length}`);
    }
    if (role !== undefined) {
      if (!TENANT_ROLES.includes(role)) return res.status(400).json({ error: { code: 'VALIDATION', message: `role must be one of: ${TENANT_ROLES.join(', ')}` } });
      params.push(role); sets.push(`role = $${params.length}`); securityChange = true;
    }
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') return res.status(400).json({ error: { code: 'VALIDATION', message: 'is_active must be a boolean' } });
      params.push(is_active); sets.push(`is_active = $${params.length}`); securityChange = true;
    }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    if (securityChange) sets.push('token_version = token_version + 1');
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, email, role, organization_id, is_active`,
      params
    );
    invalidateUserCache(req.params.id);
    const action = is_active === false ? 'user_deactivated' : is_active === true ? 'user_activated' : 'user_updated';
    await audit(req, action, 'user', req.params.id, { name, email, role, is_active });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /organizations/:id/users ─────────────────────────────────────────────
// Add another login account to a studio (beyond the owner created with the org).
router.post('/organizations/:id/users', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query('SELECT id FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role || 'admin';

    if (!name) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Name is required' } });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid email is required' } });
    if (password.length < 8) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    if (!TENANT_ROLES.includes(role)) return res.status(400).json({ error: { code: 'VALIDATION', message: `role must be one of: ${TENANT_ROLES.join(', ')}` } });

    const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That email is already in use' } });

    const hashed = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       RETURNING id, name, email, role, organization_id, is_active, created_at`,
      [userId, name, email, hashed, role, req.params.id]
    );
    await audit(req, 'user_created', 'user', userId, { email, role, organization_id: req.params.id });
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /users/:id ─────────────────────────────────────────────────────────
// Soft-delete a tenant login and revoke its sessions. Guards: cannot delete the
// platform account, yourself, or a studio's last remaining active admin.
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user?.id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'You cannot delete your own account' } });
    }
    const { rows: existing } = await pool.query(
      `SELECT id, role, organization_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    const target = existing[0];
    if (target.role === 'super_admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform accounts cannot be deleted here' } });
    }
    if (target.role === 'admin' && target.organization_id) {
      const { rows: [{ count }] } = await pool.query(
        `SELECT count(*)::int AS count FROM users
          WHERE organization_id = $1 AND role = 'admin' AND is_active = true AND deleted_at IS NULL AND id <> $2`,
        [target.organization_id, req.params.id]
      );
      if (count === 0) {
        return res.status(409).json({ error: { code: 'LAST_ADMIN', message: "Cannot delete a studio's last active admin. Add another admin first." } });
      }
    }
    await pool.query(
      `UPDATE users SET deleted_at = now(), is_active = false, token_version = token_version + 1, updated_at = now()
        WHERE id = $1`,
      [req.params.id]
    );
    invalidateUserCache(req.params.id);
    await audit(req, 'user_deleted', 'user', req.params.id, { role: target.role, organization_id: target.organization_id });
    res.json({ data: { id: req.params.id, message: 'Account removed and sessions revoked.' } });
  } catch (err) { next(err); }
});

// ── POST /users/:id/send-password-setup ──────────────────────────────────────
//
// Emails the account a link to set their OWN password, instead of the operator
// choosing one and having to convey it. Better on both counts: the operator
// never learns the password, and it never travels through a chat window.
//
// ── Why this is not just "call /auth/forgot-password for them" ───────────────
//
// The public route cannot tell the caller anything. It answers "if the email
// exists, a reset link has been sent" whether or not the address exists, and
// silently returns without sending when SMTP is unconfigured — both correct
// there, because an anonymous caller must not be able to probe which addresses
// are registered.
//
// An operator who has just opened this exact user's row is not probing. So this
// route reports what actually happened: whether the account exists, whether
// SMTP is configured, and whether the send succeeded. Without that, "no email
// arrived" is indistinguishable from "email is not set up", which is precisely
// the trap the public route sets for its own operators.
const PASSWORD_SETUP_EXPIRY_MINUTES = Math.min(
  Math.max(parseInt(process.env.PASSWORD_SETUP_EXPIRY_MINUTES, 10) || 120, 15), 1440
);

router.post('/users/:id/send-password-setup', async (req, res, next) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT id, name, email, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!users.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    const user = users[0];
    if (!user.email) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'That account has no email address to send to' } });
    }

    // Checked BEFORE issuing a token. Minting one that nobody can receive
    // would invalidate any live reset link for no benefit, and would report
    // success for an email that was never sent.
    if (!smtpConfigured()) {
      return res.status(503).json({
        error: {
          code: 'SMTP_NOT_CONFIGURED',
          message: 'Email is not configured on the server, so nothing was sent. '
            + 'Set SMTP_HOST, SMTP_USER and SMTP_PASS, then try again — '
            + 'or use Reset password to set one directly.',
        },
      });
    }

    // Same token shape as /auth/forgot-password: a random 32-byte secret, of
    // which only the SHA-256 is stored. The raw value exists in the email and
    // nowhere else, so a database leak does not hand over live reset links.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Longer than the public flow's 15 minutes, deliberately and separately.
    // There, someone is sitting at the form waiting for the mail. Here an
    // operator sends it and the recipient may be asleep; a 15-minute link
    // would mostly expire unused and train everyone to ask for another. It is
    // its own named constant rather than a change to the public window, which
    // was shortened on purpose (auth.js, M-07), and is clamped to 15 minutes
    // either side of a day so a typo in the environment cannot make a
    // password-set link effectively permanent.
    await pool.query(
      `UPDATE users
          SET password_reset_token = $1,
              password_reset_expires = NOW() + ($2 || ' minutes')::interval
        WHERE id = $3`,
      [hashedToken, String(PASSWORD_SETUP_EXPIRY_MINUTES), user.id]
    );

    try {
      await sendPasswordReset(user.email, rawToken);
    } catch (err) {
      // Undo the token rather than leave a live one behind for a link that
      // never arrived — it would silently supersede any earlier valid link.
      await pool.query(
        `UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL WHERE id = $1`,
        [user.id]
      ).catch(() => {});
      logger.error({ err: err.message, userId: user.id }, 'password setup email failed');
      return res.status(502).json({
        error: { code: 'EMAIL_SEND_FAILED', message: `The email could not be sent: ${err.message}` },
      });
    }

    // The address is recorded because it is the operative fact: an operator
    // who has just changed someone's email needs the log to show which
    // address the link actually went to. The token is not, and cannot be —
    // only its hash was ever stored.
    await audit(req, 'user_password_setup_sent', 'user', user.id, {
      email: user.email, expires_in_minutes: PASSWORD_SETUP_EXPIRY_MINUTES,
    });

    res.json({
      data: {
        id: user.id,
        email: user.email,
        expires_in_minutes: PASSWORD_SETUP_EXPIRY_MINUTES,
        message: `A set-password link was sent to ${user.email}. It expires in ${PASSWORD_SETUP_EXPIRY_MINUTES} minutes.`,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /users/:id/reset-password ────────────────────────────────────────────
// Sets a new password and revokes all existing sessions for that account.
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    }
    const hashed = await bcrypt.hash(password, 12);
    // AUD-005. This route's comment and its response both promised "existing
    // sessions revoked", but it only bumped token_version — which expires the
    // 15-minute access tokens and nothing else. The account's refresh tokens
    // stayed live for the rest of their 7-day window, so an operator resetting a
    // compromised account's password was told the sessions were gone while the
    // attacker could still mint new access tokens. The claim is now true.
    const { rows } = await pool.query(
      `WITH pw AS (
         UPDATE users SET password = $2, token_version = token_version + 1, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, email
       ), revoked AS (
         UPDATE refresh_tokens
            SET revoked_at = NOW()
          WHERE user_id = (SELECT id FROM pw)
            AND revoked_at IS NULL
       )
       SELECT id, email FROM pw`,
      [req.params.id, hashed]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    invalidateUserCache(req.params.id);
    await audit(req, 'user_password_reset', 'user', req.params.id, {});
    res.json({ data: { id: rows[0].id, message: 'Password reset. Existing sessions revoked.' } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/logo — upload/replace a studio's logo image.
router.post('/organizations/:id/logo', logoUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Logo file is required' } });
    const detected = detectLogoType(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'File is not a valid PNG, JPG, or WEBP image' } });
    }
    const { rows: orgRows } = await pool.query('SELECT id FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgRows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const filename = `${req.params.id}-${Date.now()}.${detected.ext}`;
    // The logo belongs to the studio it is being set on, not to the platform
    // owner uploading it — bill the bytes to the studio.
    const url = await saveFile('org-logos', filename, req.file.buffer, detected.mime,
      { organizationId: req.params.id, uploadedBy: req.user?.id });
    const { rows } = await pool.query(
      'UPDATE organizations SET logo_url = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [req.params.id, url]
    );
    await audit(req, 'org_logo_updated', 'organization', req.params.id, { logo_url: url });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
