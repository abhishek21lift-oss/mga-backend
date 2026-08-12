-- Weekly set targets per muscle, per studio.
--
-- ── Why this is a table and not a constant ──────────────────────────────────
--
-- The analytics screen counts how many hard sets a client did for each muscle
-- last week. That number is a FACT and needs no table. What needs a table is
-- the range it gets compared against — "is 6 sets of hamstrings enough?" —
-- because that is a coaching judgement, not a measurement.
--
-- Hard-coding the range would print a number the trainer never chose next to a
-- number measured from their client, in the same typeface, and the trainer
-- would have no way to tell which was which. So the range is stored, editable,
-- and attributed in the UI as a starting point rather than a prescription.
--
-- ── About the seeded values ─────────────────────────────────────────────────
--
-- The seeds below are commonly-cited STARTING RANGES from hypertrophy
-- programming practice, not findings from a specific study, and they are
-- deliberately not attributed to one — they circulate in roughly this form
-- across several published training systems, and dressing them up with a
-- citation would give them an authority they do not have. They exist so a new
-- studio sees something sensible on day one; they are meant to be changed.
--
-- Muscles are seeded ONLY where a range of this kind is commonly stated.
-- forearms, neck, adductors, abductors and lower back get no seed, because a
-- plausible-looking pair of numbers there would be invented rather than
-- conventional — and an invented number is worse than a blank, which at least
-- says "you decide".
--
-- ── Granularity ─────────────────────────────────────────────────────────────
--
-- Keyed on exercises.target_muscle (quadriceps, hamstrings, lats, triceps …)
-- rather than exercises.muscle_group, which in this library is eight coarse
-- buckets — Legs, Arms, Back. A "Legs" target would have to cover quads,
-- hamstrings and calves at once, and no honest single range does that.
--
-- 'shoulders' is one row because the library does not separate front, side and
-- rear delts. That is a real loss of precision and the UI says so: the range is
-- wide, and it is the row a trainer is most likely to want to change.

CREATE TABLE IF NOT EXISTS muscle_volume_landmarks (
  id              TEXT PRIMARY KEY,
  -- NULL = the platform default every studio starts from. A studio's own row
  -- for the same muscle overrides it. Same shape as the shared workout_plans
  -- template library, so the override rule is one a reader already knows.
  organization_id UUID REFERENCES organizations (id) ON DELETE CASCADE,
  target_muscle   TEXT NOT NULL,
  -- Minimum effective volume / maximum recoverable volume, in HARD SETS per
  -- week. Nullable so a trainer can clear one without inventing a value.
  mev_sets        INTEGER,
  mrv_sets        INTEGER,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT muscle_volume_landmarks_mev_check CHECK (mev_sets IS NULL OR mev_sets BETWEEN 0 AND 60),
  CONSTRAINT muscle_volume_landmarks_mrv_check CHECK (mrv_sets IS NULL OR mrv_sets BETWEEN 0 AND 60),
  -- A floor above the ceiling is not a range; it would render as a bar with a
  -- negative width and a client permanently "over" their minimum.
  CONSTRAINT muscle_volume_landmarks_order_check
    CHECK (mev_sets IS NULL OR mrv_sets IS NULL OR mev_sets <= mrv_sets)
);

-- One row per muscle per studio. Two would make "the studio's range" ambiguous
-- and the resolver would silently pick whichever the planner returned first.
CREATE UNIQUE INDEX IF NOT EXISTS muscle_volume_landmarks_org_muscle_idx
  ON muscle_volume_landmarks (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), target_muscle);

-- Seeds. ON CONFLICT DO NOTHING so re-running the migration never overwrites a
-- studio that has since edited its own values.
INSERT INTO muscle_volume_landmarks (id, organization_id, target_muscle, mev_sets, mrv_sets) VALUES
  ('mvl-chest',      NULL, 'chest',       8, 22),
  ('mvl-lats',       NULL, 'lats',       10, 25),
  ('mvl-midback',    NULL, 'middle back', 8, 25),
  ('mvl-traps',      NULL, 'traps',       4, 26),
  ('mvl-shoulders',  NULL, 'shoulders',   8, 26),
  ('mvl-biceps',     NULL, 'biceps',      8, 26),
  ('mvl-triceps',    NULL, 'triceps',     6, 24),
  ('mvl-quadriceps', NULL, 'quadriceps',  8, 20),
  ('mvl-hamstrings', NULL, 'hamstrings',  6, 20),
  ('mvl-glutes',     NULL, 'glutes',      4, 16),
  ('mvl-calves',     NULL, 'calves',      8, 20),
  ('mvl-abdominals', NULL, 'abdominals',  6, 25)
ON CONFLICT DO NOTHING;

ALTER TABLE muscle_volume_landmarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON muscle_volume_landmarks FROM anon, authenticated;
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'muscle_volume_landmarks'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON muscle_volume_landmarks
      FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $rls$;

-- The analytics query joins sets to exercises to reach target_muscle, then
-- filters by date. Without this it is a sequential scan of the library on
-- every load of the screen.
CREATE INDEX IF NOT EXISTS exercises_target_muscle_idx
  ON exercises (target_muscle) WHERE target_muscle IS NOT NULL;

ANALYZE muscle_volume_landmarks;
