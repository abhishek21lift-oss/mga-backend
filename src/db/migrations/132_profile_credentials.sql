-- ============================================================
-- 132_profile_credentials.sql
--
-- Professional credentials on a user's own profile: what they are
-- qualified to do, and when those qualifications lapse.
--
-- ── Why on user_profiles rather than trainers ────────────────────────
--
-- pt_trainers already carries `certifications` and `specialization`, but
-- as free TEXT and only for people who have a trainer record. The person
-- asking for this is an ADMIN — they own the studio, they may coach, and
-- they may have no trainer row at all. Credentials belong to the person,
-- so they live beside the rest of that person's profile. Nothing here
-- touches pt_trainers.
--
-- ── Expiry is the reason this is structured, not a text blob ─────────
--
-- CPR/AED, first aid and most CPT certifications expire, and coaching on
-- a lapsed certificate is an insurance problem rather than an
-- administrative one. Storing an issuer and an expiry date per
-- certificate is what lets the profile say "expires in 23 days" instead
-- of showing a paragraph nobody re-reads. A TEXT column cannot answer
-- that question, which is why pt_trainers.certifications is not simply
-- reused here.
--
-- ── JSONB rather than a child table ──────────────────────────────────
--
-- These are read and written as one whole list, by one person, about
-- themselves. There is no query that asks "who holds a NASM-CPT" today,
-- and no foreign key anything else needs. A child table would buy
-- referential integrity nobody is spending and cost a join on every
-- profile load. If cross-studio credential search ever becomes a
-- feature, that is the point to normalise it.
--
-- Shape, enforced in the route rather than by the database:
--   [{ id, name, issuer, issued_on, expires_on, credential_id }]
-- issued_on / expires_on are 'YYYY-MM-DD' or null. expires_on null means
-- the certificate does not expire, which is different from unknown and
-- is why it is nullable rather than defaulted.
--
-- Idempotent.
-- ============================================================

-- user_profiles is created lazily by routes/profile.js ensureSchema() on
-- first access, so on a database where nobody has opened their profile
-- yet the table may not exist when this runs. Created here with the same
-- definition so the ALTERs below always have a target; ensureSchema()'s
-- CREATE TABLE IF NOT EXISTS then becomes a no-op.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  location TEXT,
  bio TEXT,
  avatar_url TEXT,
  notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_profiles
  -- "Head Coach", "Studio Owner & S&C Coach" — what they do, as opposed
  -- to `users.role`, which is what the software lets them click.
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  -- A date, not a number of years: a stored "8 years" is wrong twelve
  -- months later and nobody comes back to correct it.
  ADD COLUMN IF NOT EXISTS experience_since DATE,
  ADD COLUMN IF NOT EXISTS specialisations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS certifications JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Both lists must be arrays. Without this a malformed write could store
-- an object or a bare string, and every reader would have to defend
-- against it — the route validates, but the route is not the only thing
-- that will ever write here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_credentials_are_arrays'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_credentials_are_arrays
      CHECK (jsonb_typeof(specialisations) = 'array'
         AND jsonb_typeof(certifications) = 'array');
  END IF;
END $$;

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

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_profiles FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'user_profiles'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON user_profiles
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
