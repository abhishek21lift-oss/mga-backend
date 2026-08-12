-- ============================================================
-- 130_admin_invitations.sql
--
-- Invitation-based onboarding for studio admins.
--
-- Until now creating a studio meant the platform operator typed a
-- password and then told the new admin what it was, out of band. That
-- means a human-chosen password travelling over WhatsApp, and an
-- operator who permanently knows a customer's credentials. This
-- replaces it: the account is created with NO usable password, and the
-- admin sets their own through a single-use link.
--
-- ── The token is never stored ────────────────────────────────────────
--
-- Only its SHA-256 hash is, exactly as password_reset_token already
-- works in this codebase. The raw token exists in the email and
-- nowhere else, so a leaked database dump cannot be used to claim a
-- pending studio account.
--
-- The consequence is deliberate and worth stating: the platform CANNOT
-- show an operator the link it already sent. "Copy invitation link"
-- has to issue a fresh token and invalidate the old one. That is the
-- price of not storing the secret, and it is the right trade.
--
-- ── Why a table rather than columns on users ─────────────────────────
--
-- password_reset_token lives on users because a reset is a momentary
-- state. An invitation is a record: it has a history (sent, resent,
-- opened, activated), it is reported on, and an expired one is still
-- evidence of what an operator did. Columns on users would keep only
-- the most recent attempt and lose the rest.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The account being claimed. TEXT because users.id is TEXT.
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Denormalised so an invitation still reads correctly in the audit
  -- trail after the account it pointed at is deleted or its email
  -- changed. This is a record of what was sent, not a live view.
  email             TEXT NOT NULL,
  owner_name        TEXT,
  studio_name       TEXT,

  -- SHA-256 of the raw token. UNIQUE so a collision is a constraint
  -- violation rather than two accounts sharing one link.
  token_hash        TEXT NOT NULL UNIQUE,

  -- Opaque id for the open-tracking pixel. Deliberately NOT the token:
  -- a tracking pixel URL travels through mail clients, image proxies
  -- and referrer headers, and must never carry the secret that grants
  -- access to the account.
  track_id          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','opened','activated','expired','cancelled')),

  expires_at        TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,
  activated_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,

  -- Delivery bookkeeping. last_error is kept so an operator can see WHY
  -- an invitation never arrived instead of only that it did not.
  send_attempts     INT NOT NULL DEFAULT 0,
  last_error        TEXT,

  -- Rule 4 of the Control Centre: who did this, when, from where.
  created_by        TEXT,
  created_by_name   TEXT,
  created_ip        TEXT,
  created_user_agent TEXT,
  activated_ip      TEXT,
  activated_user_agent TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The management list is "newest first, optionally filtered by studio".
CREATE INDEX IF NOT EXISTS admin_invitations_org_idx     ON admin_invitations (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_invitations_status_idx  ON admin_invitations (status, created_at DESC);
-- The rate limiter counts recent sends for one account.
CREATE INDEX IF NOT EXISTS admin_invitations_user_idx    ON admin_invitations (user_id, created_at DESC);

-- Same convention as every other platform table: no direct client
-- access. This one matters more than most — the table holds the hashes
-- that gate account takeover.
ALTER TABLE admin_invitations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'admin_invitations' AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON admin_invitations
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;

REVOKE ALL ON admin_invitations FROM anon, authenticated;

-- An invited admin has no password yet. users.password is NOT NULL, so
-- the row carries a bcrypt hash of a random value nobody knows rather
-- than a nullable column or an empty string — an empty string would be
-- a hash comparison away from a login bypass if any code path ever
-- stopped checking is_active.
--
-- is_active = FALSE is what actually blocks the login (middleware/auth.js
-- rejects inactive users), and activation flips it.
