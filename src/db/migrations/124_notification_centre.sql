-- ============================================================
-- 124_notification_centre.sql
--
-- Platform → studio announcements for the Control Centre.
--
-- ── Delivery model: fan-out, not join-at-read ────────────────────────
--
-- Sending writes one `notifications` row per recipient. That is more
-- writes than a single announcement row read through a join, and it is
-- the right trade here for two reasons:
--
--   1. The studio's notification bell already exists and already works.
--      Fan-out means announcements appear in it with NO change to any
--      Admin Studio code — which is the constraint this whole Control
--      Centre is built under.
--   2. Per-user read state comes free. `is_read` on each row IS the read
--      receipt, so "how many admins have seen the maintenance notice"
--      is a COUNT, not a second table to keep in step.
--
-- At this scale (tens of studios, a handful of staff each) a broadcast
-- is hundreds of rows, not millions. If that ever changes, the recipient
-- resolution is already isolated in lib/announcements.js and can be
-- swapped for a join without touching the routes.
--
-- ── Also fixes a live bug ────────────────────────────────────────────
--
-- `notifications.link` is INSERTed by six existing code paths
-- (subscription.js, subscription.worker.js, upi-payments.js,
-- notifications.service.js, super-admin.routes.js) but was created by NO
-- migration — it exists only in databases where someone added it by
-- hand. Every one of those inserts is wrapped in a try/catch that logs a
-- warning, so on a migration-built database the notification silently
-- never arrives and nothing surfaces the failure. Adding the column
-- repairs all six.
--
-- Idempotent.
-- ============================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;

-- Announcements are read back by ref_id to count read receipts; without
-- this that is a sequential scan of every notification ever sent.
CREATE INDEX IF NOT EXISTS notif_ref_idx ON notifications (ref_id) WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- Drives the tone the studio sees. 'critical' is for outages and
  -- deadlines, not for marketing — an operator who cries wolf trains
  -- studios to ignore the one that matters.
  severity      TEXT NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  link          TEXT,

  -- ── Audience ──
  -- 'all'      every active studio
  -- 'plan'     studios on any of audience_plans
  -- 'status'   studios in any of audience_statuses (trial, frozen, ...)
  -- 'studios'  an explicit list
  audience           TEXT NOT NULL DEFAULT 'all'
                     CHECK (audience IN ('all', 'plan', 'status', 'studios')),
  audience_plans     TEXT[],
  audience_statuses  TEXT[],
  audience_org_ids   UUID[],
  -- Which tenant roles inside a targeted studio receive it. Defaults to
  -- the people who can act on platform news; a maintenance window is not
  -- something a studio's members need pushed at them.
  audience_roles     TEXT[] NOT NULL DEFAULT ARRAY['admin', 'manager'],

  -- ── Lifecycle ──
  -- draft → scheduled → sent, or draft → sent. 'cancelled' only ever
  -- applies to a scheduled one that never went out; a sent announcement
  -- cannot be unsent and must not look as if it could be.
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'scheduled', 'sent', 'cancelled')),
  scheduled_for TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,

  -- Snapshotted at send. Recomputing later would silently change history
  -- as studios sign up or churn, and "who did we tell" must not drift.
  recipient_count INTEGER,
  studio_count    INTEGER,

  created_by      UUID,
  created_by_name TEXT,
  sent_by_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A scheduled announcement with no time would never fire, and a sent one
-- with no timestamp cannot be ordered. Enforced in the database because
-- the dispatcher's correctness depends on both.
DO $$ BEGIN
  ALTER TABLE platform_announcements
    ADD CONSTRAINT platform_announcements_lifecycle_coherent
    CHECK (
      (status <> 'scheduled' OR scheduled_for IS NOT NULL)
      AND (status <> 'sent'  OR sent_at IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_announcements_status  ON platform_announcements(status, created_at DESC);
-- The dispatcher's only query: what is due right now.
CREATE INDEX IF NOT EXISTS idx_announcements_due     ON platform_announcements(scheduled_for)
  WHERE status = 'scheduled';

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

ALTER TABLE platform_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_announcements FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_announcements'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON platform_announcements
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;
