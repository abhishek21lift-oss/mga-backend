-- ============================================================
-- 058_progress_tracking_setup.sql
-- Progress Tracking Setup: fixes progress_photos' client_id FK
-- (still pointed at the dead legacy `clients` table, missed when
-- strength_logs/pt_assessments were repointed in migration 054 —
-- confirmed zero existing rows, so this is a no-data-loss repoint),
-- plus two new baseline-assessment tables: Mobility & Performance
-- and Posture. Both new tables reference pt_clients(id) correctly
-- from the start.
-- ============================================================

-- ── Fix progress_photos FK (0 existing rows — verified before writing this migration) ──
ALTER TABLE progress_photos DROP CONSTRAINT progress_photos_client_id_fkey;
ALTER TABLE progress_photos ADD CONSTRAINT progress_photos_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

-- ── Mobility & Performance Assessment ──
CREATE TABLE IF NOT EXISTS pt_mobility_performance_assessments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  assessment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  assessment_number SMALLINT,

  -- Step 1: Body Regions — [{region, score(1-5), pain, restriction}]
  body_regions JSONB,

  -- Step 2: Functional Tests — [{test, score(1-5), notes, pain, restriction}]
  mobility_tests JSONB,

  -- Step 3: Performance Metrics (genuinely new — BP/resting HR already
  -- live on pt_assessments and are read from there, not duplicated here)
  grip_strength_kg     NUMERIC(5,1),
  vertical_jump_cm     NUMERIC(5,1),
  sit_reach_cm         NUMERIC(5,1),
  balance_test_seconds NUMERIC(6,1),
  reaction_time_ms     INTEGER,
  performance_notes    TEXT,

  -- Smart Mobility Analysis (computed server-side)
  mobility_score    SMALLINT,
  mobility_category TEXT,

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pmpa_client_date_idx ON pt_mobility_performance_assessments (client_id, assessment_date DESC);

-- ── Posture Assessment ──
CREATE TABLE IF NOT EXISTS pt_posture_assessments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  assessment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  assessment_number SMALLINT,

  -- Step 1: Posture Observations — same deviation vocabulary, tagged per view
  front_issues      TEXT[],
  side_issues       TEXT[],
  back_issues       TEXT[],
  other_issue_notes TEXT,

  -- Smart Posture Analysis (computed server-side)
  posture_risk_score SMALLINT,
  posture_risk_level TEXT,

  -- Step 2: Coach Notes ({initial_observations, corrective_strategy,
  -- training_focus, nutrition_focus, recovery_focus, special_instructions})
  coach_notes JSONB,

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ppa_client_date_idx ON pt_posture_assessments (client_id, assessment_date DESC);
