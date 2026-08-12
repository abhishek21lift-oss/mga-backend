-- ============================================================
-- 134_profile_portfolio_items.sql
--
-- Portfolio media: the photos and clips a coach shows people.
--
-- ── Why a table, when 133 put everything else in JSONB ───────────────
--
-- The line is not "list versus scalar". It is whether an item owns BYTES
-- and has an independent lifecycle.
--
-- Education, achievements and gyms are edited in one form and committed
-- by one button, so a JSONB column means one atomic UPDATE. Portfolio
-- inverts every part of that:
--
--   · each item owns an R2 object, so deleting one needs its key — from
--     a JSONB array that means read-modify-write of the whole gallery
--     just to learn which file to remove
--   · uploads and deletes are per-item and immediate, so two tabs
--     editing one array would silently drop each other's work
--   · reordering rewrites the entire blob instead of n integers
--   · routes/uploads.js has to resolve a served object key back to an
--     owner on every image request, which a JSONB scan cannot do
--
-- And putting a 30-item gallery inside the whole-form PUT would mean
-- every certification edit re-transmits it, and any client that forgot
-- to send it would wipe it.
--
-- ── No deleted_at, deliberately ──────────────────────────────────────
--
-- Everywhere else in this schema a soft delete preserves history worth
-- keeping. Here it would mean "the photo I deleted is still on your
-- servers", which is the wrong answer for someone's own vanity media.
-- The row is removed and the object is deleted. Storage accounting does
-- not suffer: storage_objects (migration 128) keeps its own soft-deleted
-- ledger row, which is where "how much has this studio ever uploaded" is
-- already answered.
--
-- ── Two assets, two UUIDs ────────────────────────────────────────────
--
-- A before/after holds two images. Each gets its own UUID key rather
-- than `<row-id>-after.jpg`, because uploads.js resolves ownership by
-- looking the KEY up directly and a suffixed name would not survive its
-- bare-UUID check.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_portfolio_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalised rather than joined through users: uploads.js checks this
  -- on every image request and must not join to do it.
  organization_id  UUID REFERENCES organizations(id) ON DELETE SET NULL,

  kind             TEXT NOT NULL CHECK (kind IN ('image', 'before_after', 'video_link')),
  title            TEXT,
  caption          TEXT,

  -- The primary asset. For a video_link this is the poster image.
  file_key         TEXT NOT NULL UNIQUE,
  file_url         TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  file_size_bytes  BIGINT NOT NULL CHECK (file_size_bytes >= 0),

  -- The second asset, before/after only.
  after_file_key   TEXT UNIQUE,
  after_file_url   TEXT,
  after_mime_type  TEXT,
  after_file_size_bytes BIGINT CHECK (after_file_size_bytes IS NULL OR after_file_size_bytes >= 0),

  -- video_link only. No uploaded video: lib/fileStorage.js serveFile()
  -- pipes an object with no HTTP Range support, so an uploaded MP4 could
  -- not be seeked, would restart on every scrub, and would stream the
  -- whole file through Node for every viewer.
  external_url     TEXT,

  pinned           BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A before/after with only a "before" is not a before/after, and a
  -- video card with no link is permanently broken. Enforced here because
  -- a half-formed row renders as a broken tile with no way to see why.
  CONSTRAINT portfolio_kind_shape CHECK (
       (kind = 'before_after' AND after_file_key IS NOT NULL AND external_url IS NULL)
    OR (kind = 'video_link'   AND external_url IS NOT NULL AND after_file_key IS NULL)
    OR (kind = 'image'        AND after_file_key IS NULL AND external_url IS NULL)
  )
);

-- The only read the gallery performs: pinned first, then the explicit
-- order, then newest.
CREATE INDEX IF NOT EXISTS idx_portfolio_user
  ON user_portfolio_items (user_id, pinned DESC, sort_order ASC, created_at DESC);

-- uploads.js resolves a served object key back to its owner on every
-- request, and the key may be either of the two.
CREATE INDEX IF NOT EXISTS idx_portfolio_after_key
  ON user_portfolio_items (after_file_key) WHERE after_file_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_portfolio_org
  ON user_portfolio_items (organization_id);

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

ALTER TABLE user_portfolio_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_portfolio_items FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'user_portfolio_items'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON user_portfolio_items
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
