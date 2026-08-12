-- ============================================================
-- 146_studio_registrations.sql
--
-- Self-serve signup for the 3-day free trial.
--
-- Until now the only way into the platform was for a super-admin to create the
-- studio by hand from the Command Centre. "Start free" on the landing page went
-- to the login screen, which is a dead end for someone who does not have an
-- account yet — the one thing that button exists to solve.
--
-- An application is NOT an organisation. It is somebody asking for one, and it
-- has to survive being rejected, so it lives in its own table rather than as a
-- half-built row in `organizations`. Approval is what creates the org, the
-- trainer and the user, reusing exactly the path the Command Centre already
-- uses to create a studio.
--
-- ── Why the password hash is stored here ────────────────────────────────
--
-- The applicant chooses their password at registration and must be able to log
-- in with that same password once approved. The alternative — mailing an
-- invitation link on approval — is a second way in that we would have to build
-- and they would have to notice. So the hash is taken at registration with the
-- same bcrypt cost the users table uses, carried across on approval, and the
-- column is wiped the moment it has been copied. It is never selected by the
-- admin-facing queries.
--
-- The plaintext is never stored, and the row is useless to an attacker who
-- cannot also pass the approval step.
-- ============================================================

CREATE TABLE IF NOT EXISTS studio_registrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  full_name       TEXT        NOT NULL,
  business_name   TEXT        NOT NULL,
  mobile          TEXT        NOT NULL,
  email           TEXT        NOT NULL,

  -- Cleared on approval, once copied onto the user row. NULL therefore means
  -- "already consumed, or this application was rejected".
  password_hash   TEXT,

  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Set on approval. The link back to what the application became, so a studio
  -- can always be traced to the person who asked for it.
  organization_id UUID        REFERENCES organizations(id) ON DELETE SET NULL,

  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,
  review_note     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The queue is read as "pending, oldest first" on every visit to the Command
-- Centre, which is the one query that has to stay quick as the list grows.
CREATE INDEX IF NOT EXISTS idx_studio_registrations_status_created
  ON studio_registrations (status, created_at DESC);

-- One live application per email address.
--
-- Partial rather than a plain unique constraint: somebody rejected in March
-- must be able to apply again in June, and an approved application must not
-- block the studio from ever being re-registered if it is later deleted. Only
-- 'pending' rows are constrained, so a second attempt while the first is still
-- in the queue is refused rather than creating two identical applications for
-- an admin to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_registrations_pending_email
  ON studio_registrations (lower(email))
  WHERE status = 'pending';

-- Looking up an applicant by email across all states, for support.
CREATE INDEX IF NOT EXISTS idx_studio_registrations_email
  ON studio_registrations (lower(email));

-- ── Lockdown ────────────────────────────────────────────────────────────
--
-- Same convention every table in this schema follows (see 138): the API talks
-- to Postgres as the owner and does its own tenancy, so PostgREST's anon and
-- authenticated roles get nothing. That matters more here than almost
-- anywhere else — this table holds bcrypt hashes and the contact details of
-- people who are not yet customers, and the row is created by an endpoint that
-- deliberately has no authentication in front of it.
ALTER TABLE studio_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON studio_registrations FROM anon, authenticated;
