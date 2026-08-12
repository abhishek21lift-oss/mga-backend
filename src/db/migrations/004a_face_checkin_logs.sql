-- ============================================================
-- 619 ERP — Migration 004: face_checkin_logs table
--
-- Creates the face_checkin_logs table that is referenced by
-- every route in src/routes/checkin.js but was never defined
-- in the schema or earlier migrations.
--
-- Safe to run on v3 or v4 databases (idempotent via IF NOT EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS face_checkin_logs (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id   TEXT        REFERENCES clients(id) ON DELETE SET NULL,
  status      TEXT        NOT NULL DEFAULT 'unknown'
              CHECK (status IN ('success', 'unknown', 'expired', 'denied', 'frozen', 'error')),
  distance    FLOAT8,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS face_log_client_idx ON face_checkin_logs (client_id);
CREATE INDEX IF NOT EXISTS face_log_date_idx   ON face_checkin_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS face_log_status_idx ON face_checkin_logs (status);

SELECT 'Migration 004 complete — face_checkin_logs table ready' AS status;
