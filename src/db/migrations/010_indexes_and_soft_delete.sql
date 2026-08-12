-- 010_indexes_and_soft_delete.sql
-- Adds:
--   1. deleted_at column on users for soft-delete support (auth middleware already guards this)
--   2. Performance indexes on the most-queried foreign key / filter columns
-- All statements are idempotent (IF NOT EXISTS).

-- ── 1. Soft-delete column on users ───────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index so auth middleware's "WHERE deleted_at IS NULL" is fast
CREATE INDEX IF NOT EXISTS idx_users_not_deleted
  ON users (id)
  WHERE deleted_at IS NULL;

-- ── 2. Users — email lookup (used on every login) ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email));

-- ── 3. Payments — client lookups (column is "date" in payments table) ───────────
CREATE INDEX IF NOT EXISTS idx_payments_client_id
  ON payments (client_id);

CREATE INDEX IF NOT EXISTS idx_payments_date
  ON payments (date DESC);

-- ── 4. Attendance — ref_id / date ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_ref_id
  ON attendance (ref_id);

CREATE INDEX IF NOT EXISTS idx_attendance_date
  ON attendance (date DESC);

-- ── 5. Subscriptions — client_id ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subscriptions_client_id
  ON subscriptions (client_id);

-- ── 6. Face check-in logs — client_id / created_at ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_face_checkin_logs_client_id
  ON face_checkin_logs (client_id);

CREATE INDEX IF NOT EXISTS idx_face_checkin_logs_created_at
  ON face_checkin_logs (created_at DESC);

-- ── 7. Clients — trainer_id (dashboard trainer filter) ───────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_trainer_id
  ON clients (trainer_id);

-- ── 8. Renewals — client_id ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_renewals_client_id
  ON renewals (client_id);
