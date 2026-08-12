-- ============================================================
-- 120_audit_centre_indexes.sql
--
-- Indexes for the Control Centre's Audit Centre.
--
-- activity_log is append-only and grows without bound — it already
-- carries every super-admin mutation and will carry more as the
-- Control Centre modules land. The Audit Centre filters it by time
-- window, action, entity type and actor, and always orders by
-- created_at DESC. Without these it degrades to a sequential scan
-- over the whole table on every page of every filter combination.
--
-- created_at DESC leads the composite indexes because it is in the
-- ORDER BY of every query and is also the most selective filter in
-- practice (operators look at "the last 7 days", not all time).
-- Postgres can walk a DESC index backwards, but stating the order
-- explicitly lets it satisfy filter + sort from one index.
--
-- Idempotent: IF NOT EXISTS on every index.
-- ============================================================

-- Bare time ordering: the unfiltered "latest activity" view.
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at
  ON activity_log (created_at DESC);

-- Filter-by-action, newest first.
CREATE INDEX IF NOT EXISTS idx_activity_log_action_created
  ON activity_log (action, created_at DESC);

-- Filter-by-entity-type, newest first (the "Module" filter in the UI).
CREATE INDEX IF NOT EXISTS idx_activity_log_entity_created
  ON activity_log (entity_type, created_at DESC);

-- Filter-by-actor, newest first.
CREATE INDEX IF NOT EXISTS idx_activity_log_user_created
  ON activity_log (user_id, created_at DESC);
