// src/routes/auth-google.js
// Google OAuth — verifies a Google ID token and issues the same JWT cookie as regular login.
// The user must already have an account (created by admin); we never auto-provision from Google.
const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pool');
const logger = require('../lib/logger');
const loginEvents = require('../lib/loginEvents');

const isProd = process.env.NODE_ENV === 'production';

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      logger.error('GOOGLE_CLIENT_ID is not configured');
      return res.status(500).json({ error: 'Google login is not configured on this server' });
    }

    // Verify the Google ID token using google-auth-library
    let payload;
    try {
      const { OAuth2Client } = require('google-auth-library');
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      logger.warn({ err: verifyErr.message }, 'Google token verification failed');
      return res.status(401).json({ error: 'Invalid Google credential' });
    }

    if (!payload || !payload.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    const email = payload.email;

    // Find an existing, active user by email — never auto-create
    let user;
    try {
      const { rows } = await pool.query(
        // organization_id is selected only so the login event carries studio
        // attribution; without it Google sign-ins would be invisible to the
        // Security Centre's per-studio filter. Nothing else here reads it.
        `SELECT id, name, email, role, token_version, trainer_id, member_id, is_active, organization_id
           FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true AND deleted_at IS NULL`,
        [email]
      );
      user = rows[0];
    } catch (dbErr) {
      logger.error({ err: dbErr.message }, 'Google login DB error');
      return res.status(500).json({ error: 'Database error. Please try again.' });
    }

    if (!user) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.UNKNOWN_USER, method: 'google', email,
      });
      return res.status(401).json({
        error: 'No active account found for this Google email. Contact your administrator.',
      });
    }

    // Update last login (non-critical)
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(err => logger.warn({ err: err.message }, 'last_login update failed (non-critical)'));

    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.SUCCESS, method: 'google', email,
      userId: user.id, orgId: user.organization_id,
    });

    // Sign JWT — identical shape to the regular login cookie
    let token;
    try {
      token = jwt.sign(
        { id: user.id, token_version: user.token_version },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
    } catch (jwtErr) {
      logger.error({ err: jwtErr.message }, 'JWT sign error');
      return res.status(500).json({ error: 'Token generation failed. Contact administrator.' });
    }

    setTokenCookie(res, token);

    res.json({
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        trainer_id: user.trainer_id,
        member_id:  user.member_id,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected Google login error');
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

module.exports = router;
