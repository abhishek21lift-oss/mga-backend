-- 004_db_integrity_fixes.sql
-- Add missing FK constraints, partial indexes, and updated_at triggers
-- identified by deep audit.

-- ─── 1. FK constraints on users ────────────────────────────────────────
-- schema.sql comments these as FKs but no actual constraint exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_trainer'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_trainer
      FOREIGN KEY (trainer_id) REFERENCES trainers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_member'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_member
      FOREIGN KEY (member_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── 2. Partial indexes for soft-delete ───────────────────────────────
-- Only clients had one; users, trainers, payments, plans were missing
CREATE INDEX IF NOT EXISTS users_active_idx    ON users (id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS trainers_active_idx ON trainers (id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS payments_active_idx ON payments (id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS plans_active_idx    ON plans (id)    WHERE deleted_at IS NULL;

-- ─── 3. Missing updated_at triggers ───────────────────────────────────
-- subscriptions and expenses are in the schema trigger list but may lack
-- the trigger in databases that only ran migrations (not full schema.sql)
DO $$ DECLARE t TEXT; BEGIN
  FOR t IN SELECT unnest(ARRAY['subscriptions','expenses','plans','feature_flags'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      BEGIN
        EXECUTE format(
          'CREATE TRIGGER trg_%I_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
          t, t
        );
      EXCEPTION WHEN undefined_table THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

-- ─── 4. Indexes on users FK columns ───────────────────────────────────
CREATE INDEX IF NOT EXISTS users_trainer_idx ON users (trainer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_member_idx  ON users (member_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_last_login_idx ON users (last_login) WHERE deleted_at IS NULL;

-- ─── 5. Composite indexes for common query patterns ───────────────────
CREATE INDEX IF NOT EXISTS payments_client_date_idx ON payments (client_id, date DESC);
CREATE INDEX IF NOT EXISTS leave_trainer_status_idx ON leave_requests (trainer_id, status);
CREATE INDEX IF NOT EXISTS subscriptions_active_client_idx ON subscriptions (client_id, status, end_date);
CREATE INDEX IF NOT EXISTS atlog_status_idx ON attendance_logs (status);
