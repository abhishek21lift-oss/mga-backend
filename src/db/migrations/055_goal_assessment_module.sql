-- ============================================================
-- 055_goal_assessment_module.sql
-- Rebuilds pt_goals into the backing store for the Goal Assessment
-- module: goal-type selection, target weight/body-fat, priority,
-- motivation/commitment, biggest challenges, lifestyle readiness,
-- and a deterministic Smart Goal Analysis (difficulty/duration/
-- safe rate/risk factors), computed server-side and stored so list
-- views don't need to recompute.
--
-- pt_goals is confirmed empty on the live DB (verified before
-- writing this migration), so the goal_type CHECK is redefined
-- cleanly rather than just widened, and the client_id FK is
-- repointed from the dead/empty legacy `clients` table to
-- `pt_clients` — the same fix already applied to pt_assessments and
-- strength_logs in 054_fitness_testing_module.sql, for the same
-- reason: the old FK silently blocked every insert for a real
-- (pt_clients-based) client. The other ~25 tables still pointing at
-- the legacy `clients` table are a separate, wider pre-existing
-- issue, intentionally not addressed here.
-- ============================================================

ALTER TABLE pt_goals DROP CONSTRAINT IF EXISTS pt_goals_client_id_fkey;
ALTER TABLE pt_goals ADD CONSTRAINT pt_goals_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

ALTER TABLE pt_goals DROP CONSTRAINT IF EXISTS pt_goals_goal_type_check;
ALTER TABLE pt_goals ADD CONSTRAINT pt_goals_goal_type_check
  CHECK (goal_type IN (
    'fat_loss','muscle_gain','body_recomposition','strength_gain','powerlifting',
    'endurance','general_fitness','mobility','marathon_prep','wedding_transformation',
    'medical_fitness','senior_fitness','athletic_performance','custom'
  ));

-- Custom goal (goal_other already holds the custom goal *name*)
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS goal_description TEXT;

-- Psychology / context
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS motivation_reason     TEXT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS priority_goal         TEXT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS motivation_level      SMALLINT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS commitment_level      SMALLINT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS biggest_challenges    TEXT[];

-- Lifestyle readiness
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS lifestyle_readiness       JSONB;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS lifestyle_readiness_score SMALLINT;

-- Progress-tracking baseline — snapshotted at goal-creation time so
-- completion % stays meaningful even as later assessments change "current".
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS starting_weight        NUMERIC(6,2);
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS starting_body_fat_pct  NUMERIC(4,1);

-- Smart Goal Analysis (computed server-side, never trust client input)
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS goal_difficulty              TEXT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS estimated_duration_weeks     SMALLINT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS recommended_pt_duration_months SMALLINT;
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS estimated_weekly_rate_kg     NUMERIC(4,2);
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS safe_weekly_rate_kg          NUMERIC(4,2);
ALTER TABLE pt_goals ADD COLUMN IF NOT EXISTS risk_factors                 TEXT[];

CREATE INDEX IF NOT EXISTS pg_active_idx ON pt_goals (client_id, is_active);
