-- ============================================================
-- 125_login_events.sql
--
-- Per-attempt authentication history, for the Control Centre's
-- Security Centre.
--
-- `users.last_login` already exists but answers only "when did this
-- account last get in". It cannot answer the questions that actually
-- matter after an incident: who FAILED to get in, from where, how many
-- times, against which accounts, and did any of it eventually succeed.
-- Those need one row per attempt, not one column per user.
--
-- ── Recording is strictly additive ───────────────────────────────────
--
-- Every writer is fire-and-forget and swallows its own errors, exactly
-- like the existing last_login update. Nothing here can make a login
-- fail that would otherwise have succeeded. In particular this migration
-- deliberately does NOT introduce account lockout: locking accounts
-- changes how the Admin Studio behaves for real users and can shut a
-- studio out of its own product, which is a product decision, not a side
-- effect of adding observability.
--
-- ── What is and is not stored ────────────────────────────────────────
--
-- The attempted email IS stored, including for addresses that match no
-- account — that is precisely the brute-force signal, and it is data the
-- attacker supplied about themselves. Passwords, in any form, never are:
-- there is no column for one, so no future code path can add one by
-- accident.
--
-- BIGSERIAL, not UUID: this is the highest-volume table in the schema
-- (every login attempt on the platform, forever) and is only ever read
-- in time order.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS login_events (
  id              BIGSERIAL PRIMARY KEY,

  -- NULL when the attempt named an address with no account. The event is
  -- still worth keeping — a run of them IS the attack.
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Lower-cased at write time so grouping by target works regardless of
  -- how the attacker capitalised it.
  email_attempted TEXT,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

  outcome         TEXT NOT NULL
                  CHECK (outcome IN ('success', 'bad_password', 'unknown_user',
                                     'inactive', 'mfa_required', 'mfa_failed')),
  method          TEXT NOT NULL DEFAULT 'password'
                  CHECK (method IN ('password', 'google', 'passkey', 'refresh')),

  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed's default ordering.
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events (created_at DESC);
-- "Show me this account's history" from a studio or user page.
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
-- Brute-force detection groups failures by target and by source, and only
-- ever looks at failures — so both indexes are partial and stay small even
-- as successful logins dominate the table.
CREATE INDEX IF NOT EXISTS idx_login_events_failed_email ON login_events (email_attempted, created_at DESC)
  WHERE outcome <> 'success';
CREATE INDEX IF NOT EXISTS idx_login_events_failed_ip ON login_events (ip_address, created_at DESC)
  WHERE outcome <> 'success';

-- ── Row Level Security (added retroactively — audit finding C-01) ────
--
-- This migration created the table(s) below without RLS, leaving them
-- reachable through PostgREST with the publishable key. Migration 131
-- swept the live database, but 131 sorts BEFORE this file: a database
-- rebuilt from scratch would run the sweep first and then recreate the
-- gap here. Declaring it in the migration that owns the table makes it
-- order-independent and self-contained.
--
-- Idempotent; already-applied databases are unaffected.

ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_events FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'login_events'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON login_events
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
