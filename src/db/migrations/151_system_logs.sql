-- 151_system_logs.sql
--
-- The durable half of D4's hybrid: Live Logs → memory ring → CRITICAL lines →
-- PostgreSQL → archive.
--
-- ── Why only critical lines land here ────────────────────────────────────────
--
-- This platform serves every studio from one small VPS whose Postgres is
-- already carrying the product's own load. Persisting every log line would mean
-- writing a row for roughly every request — a tax on the database, paid
-- forever, to store text that is interesting for about four minutes.
--
-- So the split is: the in-memory ring holds EVERYTHING recent and is what the
-- live tail reads, and only `error` and above reaches this table. That is the
-- set you go looking for at 2am and the set that must survive a restart. The
-- ring is fast and lossy by design; this is slow and durable by design; neither
-- pretends to be the other.
--
-- ── Why `source` and `pid` exist ─────────────────────────────────────────────
--
-- Production runs TWO node processes in separate containers, `api` and
-- `worker`. Each has its own memory ring, so the live tail on the console can
-- only ever show the API's. Without a source column an operator would look at
-- the tail, see nothing from the worker, and conclude the worker is not
-- logging — when in fact the worker's lines are in this table and nowhere else.
-- Recording the source is what makes the history genuinely more complete than
-- the live view, rather than a subset of it.
--
-- ── Retention ────────────────────────────────────────────────────────────────
--
-- Enforced by a sweep in application code (server.js), not by a partition
-- scheme. At error-only volume this table gains a handful of rows a day; a
-- partitioning setup would be more machinery than the data justifies, and the
-- index below makes the delete cheap.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS system_logs (
  id          BIGSERIAL   PRIMARY KEY,

  -- Pino's numeric level, kept as the number it logs: 50 error, 60 fatal.
  -- Stored numerically so "at least error" is a range scan rather than a set
  -- membership test against strings that could drift.
  level       SMALLINT    NOT NULL,
  level_label TEXT        NOT NULL,

  logged_at   TIMESTAMPTZ NOT NULL,
  msg         TEXT        NOT NULL,

  -- Which process wrote it: 'api' or 'worker'. See above — this is the column
  -- that makes the history worth reading.
  source      TEXT        NOT NULL DEFAULT 'api',
  pid         INTEGER,
  hostname    TEXT,

  -- Everything pino carried besides the fields above: err, req_id, queue names.
  -- JSONB rather than TEXT so a future query can filter on a context field
  -- without re-parsing every row.
  context     JSONB,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The history view's default read, and the retention sweep's delete, are both
-- "by time, newest first". One index serves both.
CREATE INDEX IF NOT EXISTS system_logs_time_idx
  ON system_logs (logged_at DESC);

-- "Show me only fatals", and "what has the worker been doing".
CREATE INDEX IF NOT EXISTS system_logs_level_time_idx
  ON system_logs (level DESC, logged_at DESC);
CREATE INDEX IF NOT EXISTS system_logs_source_time_idx
  ON system_logs (source, logged_at DESC);

-- Deny-all RLS plus revoked grants, matching migrations 148 and 150. This
-- matters more here than for most tables: log lines quote internal hostnames,
-- queue names, stack traces and configuration state, which is exactly the
-- material that should never be reachable through an anon or authenticated
-- client key. The API connects as the table owner and so bypasses RLS.
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'system_logs'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON system_logs
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded: anon/authenticated are Supabase roles and do not exist on a plain
  -- Postgres. Migrations run automatically at boot, so an unguarded REVOKE
  -- would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON system_logs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON system_logs FROM authenticated;
  END IF;
END $$;
