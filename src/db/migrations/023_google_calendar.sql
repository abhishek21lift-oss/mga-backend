-- 023_google_calendar.sql
-- Per-user Google Calendar OAuth tokens and synced event tracking.

-- Stores one row per user who has connected their Google Calendar.
-- users.id is TEXT (gen_random_uuid()::TEXT) — match the type here
CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  user_id       TEXT        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,                    -- null until first token refresh; Google returns it on first auth
  token_expiry  TIMESTAMPTZ,             -- access token expiry (refresh needed after this)
  calendar_id   TEXT        NOT NULL DEFAULT 'primary',
  scope         TEXT,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Maps a local booking/session to the Google Calendar event we created for it,
-- so we can update or delete it when the booking changes.
CREATE TABLE IF NOT EXISTS google_calendar_events (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      TEXT        NOT NULL CHECK (event_type IN ('booking', 'pt_session')),
  local_id        TEXT        NOT NULL,  -- booking.id or pt_session.id
  google_event_id TEXT        NOT NULL,
  calendar_id     TEXT        NOT NULL DEFAULT 'primary',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS google_calendar_events_user_type_local_idx
  ON google_calendar_events(user_id, event_type, local_id);
