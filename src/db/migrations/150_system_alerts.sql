-- 150_system_alerts.sql
--
-- The Alert Center's store: one row per PROBLEM, not one per observation.
--
-- ── Why this table is not an event log ───────────────────────────────────────
--
-- The collectors already grade themselves and write a sentence explaining any
-- non-green status. The naive alerting layer on top of that is "if a card is
-- not healthy, insert a row" — and it is useless. SMTP on this platform has
-- been broken continuously since launch; at a 60s evaluation tick that is 1,440
-- rows a day describing one fact. An operator learns within a week to ignore
-- the whole screen, which is the precise failure the feature exists to prevent.
--
-- So an alert here is the CONDITION, and it has a lifetime. The same problem
-- observed a thousand times is one row whose `occurrences` and `last_seen_at`
-- move. That is what makes "3 open alerts" a number worth putting on a badge.
--
-- ── The partial unique index is the dedup guarantee ──────────────────────────
--
--   CREATE UNIQUE INDEX ... ON system_alerts (fingerprint) WHERE status <> 'resolved'
--
-- At most one LIVE alert per fingerprint, enforced by Postgres rather than by
-- the service remembering to check first. This matters because the evaluator
-- runs on an interval in the API process: two overlapping ticks, or a second
-- replica, would otherwise both see "no open alert" and both insert. The index
-- makes that impossible and lets the service use a plain ON CONFLICT upsert.
--
-- Resolved rows fall out of the index, so the same condition recurring next
-- week opens a fresh alert while the old one stays in history. That is the
-- behaviour you want: a partial index is the only kind that can express
-- "unique among the live ones".
--
-- ── fingerprint = the collector name ─────────────────────────────────────────
--
-- One live alert per source, so the ceiling is the number of registered
-- collectors — currently eight. A bounded, glanceable count beats a precise
-- one nobody reads. The trade-off, recorded deliberately: a collector with two
-- simultaneous problems (database slow AND pool exhausted) is one alert whose
-- `reason` names whichever the collector graded on. If that ever bites, the
-- fingerprint can grow a sub-key without touching this schema.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS system_alerts (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,

  -- Identity of the condition. Stable across observations; see above.
  fingerprint     TEXT        NOT NULL,
  source          TEXT        NOT NULL,   -- collector name: redis, smtp, queues, …
  severity        TEXT        NOT NULL,   -- warning | timeout | critical

  title           TEXT        NOT NULL,
  -- The collector's own sentence, refreshed on each observation. The reason a
  -- card is red is written once, by the code that knows why; this never
  -- paraphrases it.
  reason          TEXT,

  status          TEXT        NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved

  occurrences     INTEGER     NOT NULL DEFAULT 1,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  acknowledged_at      TIMESTAMPTZ,
  acknowledged_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_by_name TEXT,

  resolved_at     TIMESTAMPTZ,
  -- 'auto' when the condition cleared on its own, 'manual' when a human closed
  -- it. Worth separating: a wall of manually-closed alerts means the detection
  -- is wrong, and that is only visible if the two are distinguishable.
  resolution      TEXT,

  -- When the channels were told. NULL means not yet notified, which is what
  -- makes "notify once per alert, not once per tick" a column rather than a
  -- promise. Escalation clears it so the higher severity is announced.
  notified_at     TIMESTAMPTZ,

  -- The card as it stood when the alert opened, so the history row still
  -- explains itself after the metric has long since changed.
  snapshot        JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The dedup guarantee. Partial, so resolved history does not block recurrence.
CREATE UNIQUE INDEX IF NOT EXISTS system_alerts_live_fingerprint_unique
  ON system_alerts (fingerprint)
  WHERE status <> 'resolved';

-- The Alert Center's default read: live alerts, worst and newest first.
CREATE INDEX IF NOT EXISTS system_alerts_live_idx
  ON system_alerts (status, last_seen_at DESC)
  WHERE status <> 'resolved';

-- History, filtered by source ("has Redis done this before?").
CREATE INDEX IF NOT EXISTS system_alerts_history_idx
  ON system_alerts (source, created_at DESC);

-- Defence in depth, matching migration 148 and the other 168 tables. Nothing
-- reads this through PostgREST, and alert reasons quote internal hostnames,
-- queue names and configuration posture — none of which should be reachable by
-- the anon or authenticated keys. The API connects as the table owner and so
-- bypasses RLS; this exists purely to make those client keys inert.
ALTER TABLE system_alerts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'system_alerts'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON system_alerts
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded, unlike 148's bare REVOKE: `anon` and `authenticated` are Supabase
  -- roles and do not exist on a plain Postgres. Migrations run automatically at
  -- boot (server.js runMigrationsWithRetry), so one that assumes a Supabase-only
  -- role would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON system_alerts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON system_alerts FROM authenticated;
  END IF;
END $$;
