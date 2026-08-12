// src/routes/calendar.js
// Google Calendar OAuth flow + connection status endpoints.
//
// GET  /api/calendar/auth-url    — returns the Google consent URL (auth required)
// GET  /api/calendar/callback    — OAuth2 redirect handler (no auth — Google calls this)
// GET  /api/calendar/status      — connection status for current user (auth required)
// DELETE /api/calendar/disconnect — revoke & delete tokens (auth required)

'use strict';

const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const { auth } = require('../middleware/auth');
const cal    = require('../lib/google-calendar');
const logger = require('../lib/logger');
const { frontendUrl } = require('../lib/frontendUrl');


function notConfigured(res) {
  return res.status(501).json({
    error: 'Google Calendar integration is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI.',
  });
}

// ── GET /api/calendar/auth-url ────────────────────────────────────────────────
// Returns the Google OAuth consent URL. The frontend redirects the user there.
// We embed the user_id in a short-lived signed state token so the callback can
// identify the user without needing the session cookie (Google redirects the
// browser, which loses the httpOnly cookie context in some edge cases).
router.get('/auth-url', auth, (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);

  const stateToken = jwt.sign(
    { user_id: req.user.id, purpose: 'calendar_oauth' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  const url = cal.generateAuthUrl(stateToken);
  // Log the redirect_uri so mismatches are easy to diagnose in Render logs
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  logger.info({ redirectUri }, 'Google Calendar: generated auth URL');
  res.json({ url, _debug_redirect_uri: redirectUri });
});

// ── GET /api/calendar/callback ────────────────────────────────────────────────
// Google redirects the user here after consent. We exchange the code for tokens,
// persist them, then redirect the browser to the frontend integrations page.
router.get('/callback', async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);

  const { code, state, error } = req.query;
  // Normalised: FRONTEND_URL carries a trailing slash in production, which
  // would send the user to ".com//settings/integrations" after authorising.
  const redirectBase = frontendUrl('/settings/integrations') || 'http://localhost:3000/settings/integrations';

  if (error) {
    logger.warn({ error }, 'Google Calendar OAuth denied by user');
    return res.redirect(`${redirectBase}?calendar=denied`);
  }

  if (!code || !state) {
    return res.redirect(`${redirectBase}?calendar=error&reason=missing_params`);
  }

  // Verify state token
  let userId;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== 'calendar_oauth') throw new Error('Wrong purpose');
    userId = payload.user_id;
  } catch (stateErr) {
    logger.warn({ err: stateErr.message }, 'Google Calendar: invalid state token');
    return res.redirect(`${redirectBase}?calendar=error&reason=invalid_state`);
  }

  try {
    await cal.saveTokensFromCode(userId, code);
    logger.info({ userId }, 'Google Calendar: tokens saved');
    return res.redirect(`${redirectBase}?calendar=connected`);
  } catch (tokenErr) {
    logger.error({ userId, err: tokenErr.message }, 'Google Calendar: token exchange failed');
    return res.redirect(`${redirectBase}?calendar=error&reason=token_exchange`);
  }
});

// ── GET /api/calendar/status ──────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);
  try {
    const status = await cal.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    logger.error({ err: err.message }, 'Google Calendar: status check failed');
    res.status(500).json({ error: 'Failed to check calendar status' });
  }
});

// ── DELETE /api/calendar/disconnect ──────────────────────────────────────────
router.delete('/disconnect', auth, async (req, res) => {
  if (!cal.isConfigured()) return notConfigured(res);
  try {
    await cal.disconnect(req.user.id);
    res.json({ message: 'Google Calendar disconnected' });
  } catch (err) {
    logger.error({ err: err.message }, 'Google Calendar: disconnect failed');
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

module.exports = router;
