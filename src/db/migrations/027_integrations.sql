-- Migration 027: Integrations table for persisting connection status

CREATE TABLE IF NOT EXISTS integrations (
  id           TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'disconnected',
  api_key      TEXT,
  config       JSONB NOT NULL DEFAULT '{}',
  connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
