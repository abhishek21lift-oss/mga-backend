-- ============================================================
-- 127_support_centre.sql
--
-- Two-sided support: a studio raises a ticket, the platform answers.
--
-- The Control Centre could already message studios (announcements) but
-- studios had no way to reach back — every support conversation lived in
-- somebody's inbox, invisible to the platform and unmeasurable.
--
-- ── The security property this schema is built around ────────────────
--
-- `is_internal` on a message means platform-only: an operator's note to
-- other operators, on the studio's own ticket. It MUST never reach the
-- tenant. That is enforced in two places on purpose — the tenant query
-- filters it out, and the tenant endpoint never accepts it as an input —
-- because a single point of failure here leaks operator commentary
-- about a customer to that customer.
--
-- ── Timestamps are recorded, not derived ─────────────────────────────
--
-- first_response_at and resolved_at are written when they happen rather
-- than reconstructed by scanning messages later. Response time is the
-- number a support function is judged on; deriving it from whichever
-- message happened to look like a reply would quietly change history
-- every time the derivation rule was tweaked.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  subject         TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general'
                  CHECK (category IN ('general', 'billing', 'technical', 'feature_request', 'bug', 'account')),
  -- 'urgent' exists so a studio that cannot operate is distinguishable
  -- from one that would like a feature. Set by the studio, adjustable by
  -- an operator — the person who is blocked is not always the best judge
  -- of how it ranks against everyone else's blocked.
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- open      → studio is waiting on us
  -- pending   → we are waiting on the studio
  -- resolved  → we believe it is done; the studio can still reply
  -- closed    → finished, no further replies
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'pending', 'resolved', 'closed')),

  -- Who raised it, inside the studio.
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  -- Which platform operator owns it. NULL = unassigned, which is the
  -- queue an operator works from.
  assigned_to     TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name TEXT,

  first_response_at TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A resolved ticket without a resolution time cannot be measured, and an
-- unresolved one carrying a resolution time is a contradiction. Enforced
-- in the database because the SLA figures depend on it.
DO $$ BEGIN
  ALTER TABLE support_tickets
    ADD CONSTRAINT support_tickets_resolution_coherent
    CHECK (
      (status IN ('resolved', 'closed') AND resolved_at IS NOT NULL)
      OR (status IN ('open', 'pending') AND resolved_at IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,

  -- Which side wrote it. Stored rather than inferred from the author's
  -- role, because an operator's role can change and the transcript must
  -- not re-attribute itself when it does.
  author_side TEXT NOT NULL CHECK (author_side IN ('studio', 'platform')),
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,

  body        TEXT NOT NULL,
  -- Platform-only. See the header: never selected by, and never settable
  -- from, any tenant-facing path.
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An internal note from the studio side is a contradiction that would
-- silently hide a customer's own message from them.
DO $$ BEGIN
  ALTER TABLE support_ticket_messages
    ADD CONSTRAINT support_messages_internal_is_platform_only
    CHECK (NOT is_internal OR author_side = 'platform');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The operator queue: unassigned and open first, oldest first.
CREATE INDEX IF NOT EXISTS idx_tickets_queue  ON support_tickets (status, priority, created_at);
-- A studio's own list.
CREATE INDEX IF NOT EXISTS idx_tickets_org    ON support_tickets (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON support_tickets (assigned_to, status)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON support_ticket_messages (ticket_id, created_at);

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

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support_tickets FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'support_tickets'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON support_tickets
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

ALTER TABLE support_ticket_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support_ticket_messages FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'support_ticket_messages'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON support_ticket_messages
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
