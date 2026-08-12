-- Client login: the account link, the activation record, and brute-force state.
--
-- A PT client has no login until their trainer activates one, and that only
-- becomes possible once they have paid. This migration adds the storage for
-- that; the rules live in lib/clientInvitations.js and routes/client-auth.js.
--
-- ── Why users.pt_client_id and not users.member_id ───────────────────────
--
-- `users.member_id` already exists and looks like the obvious home. It is not:
-- migration 004 put a foreign key on it to `clients(id)`, the LEGACY table,
-- which is empty in this deployment — every real client lives in `pt_clients`.
-- Writing a pt_clients id into member_id therefore fails on the constraint.
--
-- Dropping fk_users_member to reuse the column would silently widen what
-- member_id is allowed to point at for every existing reader of it
-- (requireSelfOrRole, the auth middleware, webauthn). A second, correctly
-- constrained column is narrower and cannot break any of them.

-- ── users: the link to the client, and lockout state ─────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS pt_client_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_pt_client') THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_pt_client
      FOREIGN KEY (pt_client_id) REFERENCES pt_clients(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One login per client. A second users row pointing at the same client would
-- mean two passwords for one person and no way to say which is authoritative.
CREATE UNIQUE INDEX IF NOT EXISTS users_pt_client_unique
  ON users (pt_client_id)
  WHERE pt_client_id IS NOT NULL AND deleted_at IS NULL;

-- Brute-force state. Counted in the row rather than in memory because the API
-- runs more than one instance and restarts: a per-process counter multiplies
-- the real allowance by the instance count and resets on every deploy, which
-- is precisely when someone hammering an account would get a fresh budget.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until          TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at         TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at     TIMESTAMPTZ;

-- ── pt_clients: whether this person has a login ──────────────────────────
--
-- Denormalised from users on purpose. The client list renders an activation
-- state per row, and a LEFT JOIN to users on every list query — for a boolean
-- — is a join the list does not otherwise need.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS user_id           TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS login_activated   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS activation_sent_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pt_clients_user') THEN
    ALTER TABLE pt_clients ADD CONSTRAINT fk_pt_clients_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── client_invitations ───────────────────────────────────────────────────
--
-- Deliberately a separate table from admin_invitations rather than a
-- `kind` column on it. The two have different owners (a platform operator
-- invites a studio; a trainer invites their own client), different tenancy
-- (admin_invitations rows belong to the platform, these belong to one org),
-- and different rate limits. Sharing the table would mean every query on
-- either side carrying a discriminator it must never forget.

CREATE TABLE IF NOT EXISTS client_invitations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT, not UUID: users.id is TEXT and pt_clients.id is TEXT. See
  -- user-id-columns.test.js — this exact mistake has shipped before.
  user_id              TEXT NOT NULL,
  pt_client_id         TEXT NOT NULL,
  organization_id      UUID,
  -- Who sent it. Kept even if the trainer later leaves, hence no FK.
  invited_by           TEXT,
  invited_by_name      TEXT,
  email                TEXT NOT NULL,
  client_name          TEXT,
  studio_name          TEXT,
  -- SHA-256 of the raw token. The raw value goes in the email and is never
  -- stored, the same convention as admin_invitations and password_reset_token.
  token_hash           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  expires_at           TIMESTAMPTZ NOT NULL,
  sent_at              TIMESTAMPTZ,
  activated_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  send_attempts        INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_ip           TEXT,
  created_user_agent   TEXT,
  activated_ip         TEXT,
  activated_user_agent TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The activation page resolves a raw token to exactly one row; this is the
-- only lookup on the public surface and must not be a scan.
CREATE UNIQUE INDEX IF NOT EXISTS client_invitations_token_idx
  ON client_invitations (token_hash);

-- Rate limiting counts rows created for one client inside a window.
CREATE INDEX IF NOT EXISTS client_invitations_client_idx
  ON client_invitations (pt_client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS client_invitations_org_idx
  ON client_invitations (organization_id, created_at DESC);

-- These rows carry a client's email and a token hash, and the table is the
-- gate on account creation. No client-side key has any business reading it.
-- The API connects as the table owner and so bypasses RLS.
ALTER TABLE client_invitations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'client_invitations'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON client_invitations
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded: anon/authenticated are Supabase roles and do not exist on a plain
  -- Postgres. Migrations run automatically at boot, so an unguarded REVOKE
  -- would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON client_invitations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON client_invitations FROM authenticated;
  END IF;
END $$;
