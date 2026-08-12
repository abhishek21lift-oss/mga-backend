-- 046_branch_scope_and_pgvector.sql
-- 1. Add branch_id to payments and attendance_logs so branchScope isolation works
-- 2. Install pgvector and add vector column to face_descriptors for O(1) matching
-- 3. Performance indexes: attendance by date, face_checkin_logs by created_at

-- ─── 1. Branch ID on payments ────────────────────────────────────────────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS branch_id TEXT;

-- Backfill from the linked client's branch_id where we know it.
--
-- Guarded on clients.branch_id, which no tracked migration ever adds — it
-- exists on the live database because it was created out of band. Without the
-- guard this statement aborts a fresh database, and there is nothing for it to
-- do there anyway: a database being created for the first time has no payment
-- rows to backfill.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'branch_id'
  ) THEN
    UPDATE payments p
       SET branch_id = c.branch_id
      FROM clients c
     WHERE p.client_id = c.id
       AND p.branch_id IS NULL
       AND c.branch_id IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_branch_id ON payments (branch_id)
  WHERE branch_id IS NOT NULL;

-- ─── 2. Branch ID on attendance_logs ─────────────────────────────────────────
ALTER TABLE attendance_logs
  ADD COLUMN IF NOT EXISTS branch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_logs_branch_id ON attendance_logs (branch_id)
  WHERE branch_id IS NOT NULL;

-- ─── 3. Performance index on attendance_logs by date ─────────────────────────
-- Supports date-range report queries.
CREATE INDEX IF NOT EXISTS idx_attendance_logs_date
  ON attendance_logs (date DESC, ref_type);

-- ─── 4. Performance index on face_checkin_logs by created_at ─────────────────
-- Supports archiving jobs and recent-logs queries.
CREATE INDEX IF NOT EXISTS idx_face_checkin_logs_created_at
  ON face_checkin_logs (created_at DESC);

-- ─── 5. pgvector extension and vector column on face_descriptors ──────────────
-- Supabase supports pgvector — this enables O(log N) ANN face matching
-- instead of the current O(N) JavaScript loop.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE face_descriptors
  ADD COLUMN IF NOT EXISTS descriptor_vec vector(128);

-- Backfill from existing plaintext JSONB descriptor column.
-- This runs on first migration; new enrollments populate both columns going forward.
UPDATE face_descriptors
   SET descriptor_vec = descriptor::text::vector
 WHERE descriptor_vec IS NULL
   AND descriptor IS NOT NULL;

-- IVFFlat index for approximate nearest-neighbour search.
-- lists=100 is appropriate for up to ~10k enrolled members.
-- For >10k members, increase lists proportionally (sqrt(n_rows) is a good heuristic).
CREATE INDEX IF NOT EXISTS idx_face_descriptors_vec
  ON face_descriptors USING ivfflat (descriptor_vec vector_l2_ops)
  WITH (lists = 100)
  WHERE is_active = TRUE;
