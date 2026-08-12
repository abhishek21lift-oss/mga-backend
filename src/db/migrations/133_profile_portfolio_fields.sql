-- ============================================================
-- 133_profile_portfolio_fields.sql
--
-- The rest of a professional profile: how someone describes their
-- practice, where they have worked, when they are available, what they
-- studied and what they have won.
--
-- ── Why these are JSONB on user_profiles and portfolio is not ────────
--
-- Everything here is small, bounded, owned by exactly one person and
-- always read as a whole with the rest of their profile. No other query
-- filters on a language or joins to a previous gym, and nothing else
-- holds a foreign key to one. A child table per list would buy
-- referential integrity nobody is spending and cost four joins on every
-- profile load. Same reasoning that put `certifications` here in 132.
--
-- Portfolio MEDIA is the opposite case and gets its own table in 134:
-- it has files, ordering, pinning and per-item deletion, so a JSONB blob
-- would mean rewriting the whole gallery to reorder two photos.
--
-- ── Shapes, enforced in the route rather than by the database ────────
--
--   languages        ["English", "Hindi"]
--   coaching_modes   ["online", "offline", "hybrid", "home", "video"]
--   previous_gyms    [{ id, name, role, from, to }]        dates 'YYYY-MM'
--   education        [{ id, institution, degree, field, year }]
--   achievements     [{ id, title, kind, issuer, year, detail }]
--   working_hours    { mon: [{from,to}], tue: [...], ... }  times 'HH:MM'
--
-- working_hours is an OBJECT keyed by day, not an array: the question
-- asked of it is always "what are Tuesday's hours", and an array would
-- make every reader scan for the right day and cope with duplicates.
-- Each day holds a list of ranges because split shifts are normal in
-- this trade — a coach working 06:00-10:00 and 17:00-21:00 is the rule,
-- not the exception, and a single from/to per day cannot say that.
--
-- Idempotent.
-- ============================================================

ALTER TABLE user_profiles
  -- Cover banner, alongside the existing avatar_url.
  ADD COLUMN IF NOT EXISTS cover_url        TEXT,
  -- Distinct from `job_title` (added in 132): job_title is the label on
  -- the profile ("Head Coach"), designation is the formal role held at
  -- the current gym. Kept apart because a person can be "Founder" and
  -- work a floor shift as "Strength Coach".
  ADD COLUMN IF NOT EXISTS designation      TEXT,
  ADD COLUMN IF NOT EXISTS philosophy       TEXT,
  ADD COLUMN IF NOT EXISTS training_style   TEXT,
  ADD COLUMN IF NOT EXISTS current_gym      TEXT,
  ADD COLUMN IF NOT EXISTS languages        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS coaching_modes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS previous_gyms    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS education        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS achievements     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS working_hours    JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The route validates, but the route is not the only thing that will
-- ever write here. A list that arrives as an object, or hours that
-- arrive as an array, would make every reader defend against a shape
-- that should have been impossible. Mirrors
-- user_profiles_credentials_are_arrays from 132.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_profile_lists_are_arrays'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_profile_lists_are_arrays
      CHECK (jsonb_typeof(languages)      = 'array'
         AND jsonb_typeof(coaching_modes) = 'array'
         AND jsonb_typeof(previous_gyms)  = 'array'
         AND jsonb_typeof(education)      = 'array'
         AND jsonb_typeof(achievements)   = 'array'
         AND jsonb_typeof(working_hours)  = 'object');
  END IF;
END $$;
