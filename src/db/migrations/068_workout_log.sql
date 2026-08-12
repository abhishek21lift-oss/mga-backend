-- ============================================================
-- 068_workout_log.sql
-- Workout Log — records what was actually performed in a training
-- session, distinct from workout_plans/workout_exercises (prescribed
-- templates) and workout_assignments (which plan a client is on).
-- Also distinct from strength_logs (a lighter-weight, exercise-name-only
-- quick-log used by /pt-os/strength-tracking) — this is additive, not a
-- replacement; strength_logs is untouched.
--
-- Three tables: a session header, the exercises performed within it
-- (FK'd to the real exercises library, with a name snapshot for
-- resilience if an exercise is later renamed/deleted), and the
-- individual sets logged per exercise (true per-set granularity, with
-- RPE/RIR/tempo — none of which exist in strength_logs).
-- ============================================================

CREATE TABLE IF NOT EXISTS workout_sessions (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id              TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id             TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  workout_assignment_id  TEXT REFERENCES workout_assignments(id) ON DELETE SET NULL,
  session_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  program_name           TEXT,
  workout_day            TEXT,
  notes                  TEXT,
  duration_minutes       INTEGER,
  status                 TEXT NOT NULL DEFAULT 'in_progress',

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workout_sessions_status_check CHECK (status IN ('in_progress', 'completed'))
);

CREATE INDEX IF NOT EXISTS ws_client_date_idx ON workout_sessions (client_id, session_date DESC);

CREATE TABLE IF NOT EXISTS workout_session_exercises (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  session_id   TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id  TEXT REFERENCES exercises(id) ON DELETE SET NULL,
  -- Snapshot at time of logging — survives exercise_id going NULL
  -- (exercise deleted/renamed later) and avoids a join for display.
  exercise_name TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wse_session_idx  ON workout_session_exercises (session_id, sort_order);
CREATE INDEX IF NOT EXISTS wse_exercise_idx ON workout_session_exercises (exercise_id);

CREATE TABLE IF NOT EXISTS workout_sets (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  session_exercise_id TEXT NOT NULL REFERENCES workout_session_exercises(id) ON DELETE CASCADE,
  set_number          INTEGER NOT NULL,
  weight_kg           NUMERIC(6,2),
  reps                INTEGER,
  rpe                 NUMERIC(3,1),
  rir                 SMALLINT,
  tempo               TEXT,
  rest_seconds        INTEGER,
  completed           BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,

  -- Computed server-side at write time (see workout-log.routes.js) by
  -- comparing against the client's prior completed sets for the same
  -- exercise — never trusted from the client.
  is_pr_weight  BOOLEAN NOT NULL DEFAULT FALSE,
  is_pr_reps    BOOLEAN NOT NULL DEFAULT FALSE,
  is_pr_volume  BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wsets_exercise_idx ON workout_sets (session_exercise_id, set_number);

-- RLS: same deny-all-direct-access convention as every other table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workout_sessions', 'workout_session_exercises', 'workout_sets'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format('CREATE POLICY deny_all_direct_access ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
