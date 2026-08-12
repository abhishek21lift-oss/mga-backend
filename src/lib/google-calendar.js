// src/lib/google-calendar.js
// Google Calendar integration — OAuth2 client, token management, event CRUD.
// All exported async functions are safe to call fire-and-forget: they catch and
// log their own errors so callers never need to handle calendar failures.

'use strict';

const { google }  = require('googleapis');
const pool        = require('../db/pool');
const logger      = require('./logger');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// ── OAuth2 client factory ─────────────────────────────────────────────────────

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );
}

/**
 * Returns true if the server is configured for Google Calendar.
 * Routes gate on this so they can return a clear 501 when not configured.
 */
function isConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );
}

// ── Auth URL generation ───────────────────────────────────────────────────────

/**
 * Generate the Google OAuth consent URL.
 * @param {string} stateToken  - Signed JWT (short-lived) containing the user_id.
 * @returns {string} URL to redirect the user to.
 */
function generateAuthUrl(stateToken) {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',      // request refresh token
    prompt: 'consent',           // force consent so refresh token is always returned
    scope: SCOPES,
    state: stateToken,
  });
}

// ── Token management ──────────────────────────────────────────────────────────

/**
 * Exchange an auth code for tokens and persist them for the user.
 */
async function saveTokensFromCode(userId, code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  await upsertTokens(userId, tokens);
  return tokens;
}

async function upsertTokens(userId, tokens) {
  await pool.query(
    `INSERT INTO google_calendar_tokens
       (user_id, access_token, refresh_token, token_expiry, scope, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, google_calendar_tokens.refresh_token),
       token_expiry  = EXCLUDED.token_expiry,
       scope         = EXCLUDED.scope,
       updated_at    = NOW()`,
    [
      userId,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      tokens.scope || null,
    ]
  );
}

/**
 * Load and auto-refresh tokens for a user. Returns null if not connected.
 */
async function getAuthorizedClient(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM google_calendar_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;

  const row = rows[0];
  const client = createOAuth2Client();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.token_expiry ? new Date(row.token_expiry).getTime() : undefined,
  });

  // Auto-refresh when token is expired or within 5 minutes of expiry
  const expiresAt = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
  if (!expiresAt || Date.now() > expiresAt - 5 * 60 * 1000) {
    if (!row.refresh_token) {
      logger.warn({ userId }, 'Google Calendar: access token expired and no refresh token — disconnecting');
      await pool.query('DELETE FROM google_calendar_tokens WHERE user_id = $1', [userId]);
      return null;
    }
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await upsertTokens(userId, credentials);
    } catch (refreshErr) {
      logger.warn({ userId, err: refreshErr.message }, 'Google Calendar: token refresh failed — disconnecting');
      await pool.query('DELETE FROM google_calendar_tokens WHERE user_id = $1', [userId]);
      return null;
    }
  }

  return { client, row };
}

// ── Status ────────────────────────────────────────────────────────────────────

async function getStatus(userId) {
  const { rows } = await pool.query(
    'SELECT connected_at, last_sync_at, calendar_id FROM google_calendar_tokens WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return { connected: false };
  return {
    connected:    true,
    connectedAt:  rows[0].connected_at,
    lastSyncAt:   rows[0].last_sync_at,
    calendarId:   rows[0].calendar_id,
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────────

async function disconnect(userId) {
  const authorized = await getAuthorizedClient(userId);
  if (authorized) {
    try {
      await authorized.client.revokeCredentials();
    } catch (_) {
      // Best-effort revoke — proceed even if it fails
    }
  }
  await pool.query('DELETE FROM google_calendar_tokens WHERE user_id = $1', [userId]);
  await pool.query(
    "DELETE FROM google_calendar_events WHERE user_id = $1 AND event_type = 'booking'",
    [userId]
  );
}

// ── Event operations ──────────────────────────────────────────────────────────

/**
 * Create a Google Calendar event for a confirmed booking.
 * Fire-and-forget safe: catches all errors internally.
 */
async function createBookingEvent(userId, bookingId) {
  try {
    const authorized = await getAuthorizedClient(userId);
    if (!authorized) return;

    // Fetch booking + session details for the event body
    const { rows } = await pool.query(
      `SELECT b.id, b.status,
              cs.starts_at, cs.ends_at,
              ct.name AS class_name,
              t.name  AS trainer_name,
              br.name AS branch_name
       FROM bookings b
       JOIN class_sessions cs  ON cs.id = b.session_id
       JOIN class_templates ct ON ct.id = cs.template_id
       LEFT JOIN trainers t    ON t.id  = cs.trainer_id
       LEFT JOIN branches br   ON br.id = cs.branch_id
       WHERE b.id = $1`,
      [bookingId]
    );
    if (!rows[0]) return;
    const bk = rows[0];

    const calId = authorized.row.calendar_id || 'primary';
    const calendar = google.calendar({ version: 'v3', auth: authorized.client });

    const event = await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary:     `${bk.class_name} — MY PT STUDIO`,
        description: [
          `Class: ${bk.class_name}`,
          bk.trainer_name ? `Trainer: ${bk.trainer_name}` : null,
          `Status: Confirmed`,
          `Booking ID: ${bk.id}`,
        ].filter(Boolean).join('\n'),
        location:  bk.branch_name ? `MY PT STUDIO — ${bk.branch_name}` : 'MY PT STUDIO',
        start:     { dateTime: bk.starts_at },
        end:       { dateTime: bk.ends_at   },
        colorId:   '11',  // Tomato — gym-brand red-ish
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 15 },
          ],
        },
      },
    });

    const googleEventId = event.data.id;

    // Store the Google event ID so we can delete it on cancellation
    await pool.query(
      `INSERT INTO google_calendar_events (user_id, event_type, local_id, google_event_id, calendar_id)
       VALUES ($1, 'booking', $2, $3, $4)
       ON CONFLICT (user_id, event_type, local_id) DO UPDATE SET
         google_event_id = EXCLUDED.google_event_id,
         calendar_id     = EXCLUDED.calendar_id`,
      [userId, bookingId, googleEventId, calId]
    );

    // Update last_sync_at
    await pool.query(
      'UPDATE google_calendar_tokens SET last_sync_at = NOW() WHERE user_id = $1',
      [userId]
    );

    logger.info({ userId, bookingId, googleEventId }, 'Google Calendar: booking event created');
  } catch (err) {
    logger.warn({ userId, bookingId, err: err.message }, 'Google Calendar: createBookingEvent failed (non-critical)');
  }
}

/**
 * Delete the Google Calendar event when a booking is cancelled.
 * Fire-and-forget safe.
 */
async function deleteBookingEvent(userId, bookingId) {
  try {
    const authorized = await getAuthorizedClient(userId);
    if (!authorized) return;

    const { rows } = await pool.query(
      "SELECT google_event_id, calendar_id FROM google_calendar_events WHERE user_id = $1 AND event_type = 'booking' AND local_id = $2",
      [userId, bookingId]
    );
    if (!rows[0]) return;

    const calendar = google.calendar({ version: 'v3', auth: authorized.client });
    await calendar.events.delete({
      calendarId: rows[0].calendar_id || 'primary',
      eventId:    rows[0].google_event_id,
    }).catch(() => {}); // ignore 404 (event already deleted in Google Calendar)

    await pool.query(
      "DELETE FROM google_calendar_events WHERE user_id = $1 AND event_type = 'booking' AND local_id = $2",
      [userId, bookingId]
    );

    await pool.query(
      'UPDATE google_calendar_tokens SET last_sync_at = NOW() WHERE user_id = $1',
      [userId]
    );

    logger.info({ userId, bookingId }, 'Google Calendar: booking event deleted');
  } catch (err) {
    logger.warn({ userId, bookingId, err: err.message }, 'Google Calendar: deleteBookingEvent failed (non-critical)');
  }
}

module.exports = {
  isConfigured,
  generateAuthUrl,
  saveTokensFromCode,
  getStatus,
  disconnect,
  createBookingEvent,
  deleteBookingEvent,
};
