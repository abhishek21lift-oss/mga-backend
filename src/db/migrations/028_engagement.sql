-- Migration 028: Engagement tables (campaigns, offers, feedback, communication)

-- ── Campaigns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'email',
  status       TEXT NOT NULL DEFAULT 'draft',
  audience     TEXT NOT NULL DEFAULT 'all',
  subject      TEXT,
  body         TEXT,
  scheduled_at TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  open_count   INTEGER NOT NULL DEFAULT 0,
  click_count  INTEGER NOT NULL DEFAULT 0,
  conversions  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- ── Offers & Promotions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offers (
  id              TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  discount_type   TEXT NOT NULL DEFAULT 'percent',
  discount_value  NUMERIC(10,2) NOT NULL DEFAULT 0,
  code            TEXT UNIQUE,
  audience        TEXT NOT NULL DEFAULT 'all',
  max_uses        INTEGER,
  used_count      INTEGER NOT NULL DEFAULT 0,
  valid_from      DATE,
  valid_until     DATE,
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_code   ON offers(code);

-- ── Feedback ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  member_id    TEXT REFERENCES clients(id) ON DELETE SET NULL,
  member_name  TEXT,
  type         TEXT NOT NULL DEFAULT 'general',
  rating       SMALLINT CHECK (rating BETWEEN 1 AND 5),
  message      TEXT NOT NULL,
  reply        TEXT,
  replied_at   TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_member ON feedback(member_id);

-- ── Communication history ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communication_history (
  id           TEXT DEFAULT gen_random_uuid()::TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'announcement',
  audience     TEXT NOT NULL DEFAULT 'all',
  recipients   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'sent',
  sent_by      TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_history_sent_at ON communication_history(sent_at DESC);
