-- ============================================================
-- 136_workout_exercise_params.sql
--
-- Gives a planned exercise the parameters a personal trainer actually
-- programmes with. Until now workout_exercises stored only sets, reps,
-- rest_seconds and notes, so a trainer could say "4 x 8, 90s rest" and
-- nothing more — no load, no tempo, no intensity target, no warm-up.
--
-- ── Why every column is nullable ────────────────────────────────────
--
-- This is additive by design. Existing rows keep working untouched, the
-- existing PUT /api/workouts/plans/:id keeps accepting the payload it
-- always accepted, and a client that knows nothing about these fields
-- reads and writes plans exactly as before. Nothing here can break a
-- deploy that is mid-rollout.
--
-- ── The two columns nobody asked for yet ────────────────────────────
--
-- superset_group and config exist so the next round of programming
-- features is a data change rather than another migration.
--
--   superset_group  Exercises sharing a value are performed together.
--                   That one key expresses supersets, giant sets and
--                   circuit training — they differ only in how many
--                   exercises share the group and how the UI labels it.
--                   TEXT rather than an integer so a group can be named
--                   ("A1/A2") the way trainers actually write them.
--
--   config          Everything whose shape is per-method and would
--                   otherwise become a column each: drop sets (the drop
--                   percentages), AMRAP and EMOM (a time cap), timed
--                   sets (duration), pause reps (pause length), tempo
--                   variants, voice notes (a URL), AI suggestions.
--                   JSONB, so it is queryable if one of these ever needs
--                   reporting, rather than an opaque TEXT blob.
--
-- The alternative — a column per method — means a migration and a
-- deploy every time a trainer wants a new set type, on a table that is
-- read on every plan load. This keeps the hot columns typed and narrow
-- and lets the long tail live in one place.
--
-- ── Types, and why ──────────────────────────────────────────────────
--
--   target_weight  NUMERIC(6,2) — up to 9999.99. Kilograms or pounds is
--                  a studio-level display concern; the number is stored
--                  as entered. NUMERIC not REAL: this is prescribed load
--                  that gets compared against logged load, and binary
--                  floating point makes 62.5 stop equalling 62.5.
--   tempo          TEXT — the standard four-figure notation, "3-1-2-0"
--                  (eccentric-pause-concentric-pause). Not four integer
--                  columns: it is written, read and copied as one token,
--                  and "X" is a legitimate value meaning explosive.
--   rpe            NUMERIC(3,1) — one field for RPE (6-10, half points
--                  used) or RIR (0-5). Which scale a studio uses is a
--                  preference, not a schema difference, and storing both
--                  would invite rows that set neither or disagree.
--   warmup_sets    INTEGER — warm-ups are counted, not prescribed in
--                  detail; a trainer says "2 warm-up sets", not what
--                  they contain.
--
-- No index added. These are read as part of a plan the query already
-- fetches by workout_plan_id, never filtered on. Adding indexes nothing
-- queries is what produced the 285 unused indexes in migration 135.
--
-- workout_exercises already carries RLS and a deny-all policy from
-- migration 131; adding columns needs no policy change.
--
-- Idempotent, and safe to re-run.
-- ============================================================

ALTER TABLE public.workout_exercises
  ADD COLUMN IF NOT EXISTS target_weight  NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS tempo          TEXT,
  ADD COLUMN IF NOT EXISTS rpe            NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS warmup_sets    INTEGER,
  ADD COLUMN IF NOT EXISTS superset_group TEXT,
  ADD COLUMN IF NOT EXISTS config         JSONB;

-- Guard rails on the two numeric fields that have a meaningful range.
-- Written as NOT VALID-free plain CHECKs because every existing row has
-- NULL in these columns, so there is nothing to validate against.
--
-- rpe spans both scales: RIR is 0-5 and RPE is 6-10, so 0-10 admits
-- both without the schema having to know which one a studio uses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workout_exercises_rpe_range'
       AND conrelid = 'public.workout_exercises'::regclass
  ) THEN
    ALTER TABLE public.workout_exercises
      ADD CONSTRAINT workout_exercises_rpe_range
      CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workout_exercises_warmup_sets_range'
       AND conrelid = 'public.workout_exercises'::regclass
  ) THEN
    ALTER TABLE public.workout_exercises
      ADD CONSTRAINT workout_exercises_warmup_sets_range
      CHECK (warmup_sets IS NULL OR (warmup_sets >= 0 AND warmup_sets <= 20));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workout_exercises_target_weight_nonneg'
       AND conrelid = 'public.workout_exercises'::regclass
  ) THEN
    ALTER TABLE public.workout_exercises
      ADD CONSTRAINT workout_exercises_target_weight_nonneg
      CHECK (target_weight IS NULL OR target_weight >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.workout_exercises.target_weight  IS 'Prescribed load. Unit is a studio display preference.';
COMMENT ON COLUMN public.workout_exercises.tempo          IS 'Four-figure tempo, e.g. 3-1-2-0. X means explosive.';
COMMENT ON COLUMN public.workout_exercises.rpe            IS 'Target intensity: RPE 6-10 or RIR 0-5, one scale per studio.';
COMMENT ON COLUMN public.workout_exercises.warmup_sets    IS 'Count of warm-up sets before the working sets.';
COMMENT ON COLUMN public.workout_exercises.superset_group IS 'Exercises sharing a value are performed together (superset / giant set / circuit).';
COMMENT ON COLUMN public.workout_exercises.config         IS 'Per-method parameters: drop sets, AMRAP/EMOM caps, timed sets, pause reps, voice notes.';
