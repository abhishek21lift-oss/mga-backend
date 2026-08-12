-- Weeks and progression for workout programmes.
--
-- ── The problem this solves ─────────────────────────────────────────────────
--
-- A programme was one week: workout_exercises rows keyed by day_of_week 1-7,
-- repeated unchanged for however many weeks duration_weeks said. So a trainer
-- either accepted the same numbers for twelve weeks, or edited the plan by hand
-- every week — and the client's log showed week 1's prescription in week 9.
--
-- The obvious fix is to store every week: 12 weeks x 4 days = 48 day-plans to
-- author. That is what makes most programme builders unusable, so it is not
-- what this does.
--
-- ── The model ───────────────────────────────────────────────────────────────
--
-- The trainer authors ONE week and picks a progression rule. Weeks 2..N are
-- DERIVED, not stored: week N's prescription is week 1's with the rule applied
-- (N-1) times. Nothing is written per week, so a 12-week programme is the same
-- four rows as a 1-week one.
--
-- week_number exists on workout_exercises anyway, because a derived week has to
-- be overridable — a trainer who wants week 4 to be a deload writes real rows
-- for week 4, and those win over the derived numbers. Rows written before this
-- migration are week 1 by definition, which is what the DEFAULT encodes.

ALTER TABLE workout_exercises
  ADD COLUMN IF NOT EXISTS week_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workout_exercises DROP CONSTRAINT IF EXISTS workout_exercises_week_number_check;
ALTER TABLE workout_exercises
  ADD CONSTRAINT workout_exercises_week_number_check CHECK (week_number >= 1);

-- The lookup the log does on every session: "what does this plan prescribe for
-- week 3, Thursday". Without this it is a sequential scan of the plan's rows.
CREATE INDEX IF NOT EXISTS workout_exercises_plan_week_day_idx
  ON workout_exercises (workout_plan_id, week_number, day_of_week);

-- ── The rule ────────────────────────────────────────────────────────────────
--
-- Deliberately three columns and not a rules engine. What a trainer actually
-- writes on a whiteboard is "add 2.5kg a week" or "add a rep a week", and every
-- extra knob here is one more thing to fill in before a programme can exist.
--
--   none   the programme repeats unchanged — the behaviour before this
--          migration, and still the default so nothing changes by surprise
--   weight add `amount` kg to target_weight
--   reps   add `amount` reps
--   rpe    add `amount` to the target RPE, capped at 10 by the resolver
ALTER TABLE workout_plans
  ADD COLUMN IF NOT EXISTS progression_type TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS progression_amount NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS progression_every_weeks INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_progression_type_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_progression_type_check
  CHECK (progression_type IN ('none', 'weight', 'reps', 'rpe'));

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_progression_every_weeks_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_progression_every_weeks_check
  CHECK (progression_every_weeks BETWEEN 1 AND 12);

-- A rule with no amount cannot progress anything, and an amount with no rule is
-- ignored — either is a half-configured programme that would silently behave as
-- 'none'. Better to make the pair impossible to get wrong.
ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_progression_amount_check;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_progression_amount_check
  CHECK (progression_type = 'none' OR progression_amount IS NOT NULL);

-- ── Versioning ──────────────────────────────────────────────────────────────
--
-- Editing a plan a client is already running rewrites what they were told to
-- do. Their LOG is unaffected — workout_sessions and workout_sets record what
-- actually happened, independently — so history is already safe. What is lost
-- is the prescription itself: what the plan said in March.
--
-- version + parent_plan_id makes a snapshot possible without making it
-- automatic. Auto-versioning would be wrong here: the builder autosaves on
-- every field blur, so it would mint a version per keystroke-ish edit. This is
-- for the deliberate "save as a new version" action.
ALTER TABLE workout_plans
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_plan_id TEXT;

ALTER TABLE workout_plans DROP CONSTRAINT IF EXISTS workout_plans_parent_fk;
ALTER TABLE workout_plans
  ADD CONSTRAINT workout_plans_parent_fk
  FOREIGN KEY (parent_plan_id) REFERENCES workout_plans (id) ON DELETE SET NULL;

-- FK indexes: migration 135 exists because 29 of these were missing.
CREATE INDEX IF NOT EXISTS workout_plans_parent_plan_id_idx
  ON workout_plans (parent_plan_id);

ANALYZE workout_exercises;
ANALYZE workout_plans;
