-- ============================================================
-- 141_exercise_library_backfill.sql
-- Normalizes the 890 rows that 140 gave new columns to.
--
-- Idempotent by construction: every statement is guarded so re-running
-- changes nothing. Slugs are only generated where NULL, lookups only joined
-- where the FK is still empty, join rows use ON CONFLICT DO NOTHING.
--
-- The version-history trigger is switched off for the duration. A backfill is
-- not an edit a trainer made, and leaving it on would open every exercise's
-- history with 890 machine-authored revisions that bury the real ones.
-- ============================================================

ALTER TABLE exercises DISABLE TRIGGER exercises_version_history;


-- ─── SLUGS ───────────────────────────────────────────────────
-- 4 name collisions exist in the imported set ("Pushups" appears twice from
-- different source records). The partition + row_number suffixes the later
-- ones rather than failing the unique index.
WITH slugged AS (
  SELECT
    id,
    trim(BOTH '-' FROM regexp_replace(lower(unaccent(name)), '[^a-z0-9]+', '-', 'g')) AS base,
    row_number() OVER (
      PARTITION BY trim(BOTH '-' FROM regexp_replace(lower(unaccent(name)), '[^a-z0-9]+', '-', 'g'))
      ORDER BY created_at, id
    ) AS rn
  FROM exercises
  WHERE slug IS NULL
)
UPDATE exercises e
   SET slug = CASE WHEN s.rn = 1 THEN s.base ELSE s.base || '-' || s.rn END
  FROM slugged s
 WHERE s.id = e.id
   AND s.base <> '';


-- ─── PRIMARY MUSCLE FK ───────────────────────────────────────
-- `target_muscle` is lowercase free text from the import ("middle back");
-- muscles.slug is the normalized form ("middle-back"), so the join is on the
-- slugified value rather than on name.
UPDATE exercises e
   SET primary_muscle_id = m.id
  FROM muscles m
 WHERE e.primary_muscle_id IS NULL
   AND e.target_muscle IS NOT NULL
   AND m.slug = trim(BOTH '-' FROM regexp_replace(lower(e.target_muscle), '[^a-z0-9]+', '-', 'g'));

-- Rows with no target_muscle at all (17 of them) still need a filterable
-- bucket, so fall back to the coarser muscle_group they already carry.
UPDATE exercises e
   SET primary_muscle_id = m.id
  FROM muscles m
 WHERE e.primary_muscle_id IS NULL
   AND m.body_region = e.muscle_group
   AND m.slug = trim(BOTH '-' FROM regexp_replace(lower(e.muscle_group), '[^a-z0-9]+', '-', 'g'));


-- ─── EQUIPMENT FK ────────────────────────────────────────────
UPDATE exercises e
   SET equipment_id = q.id
  FROM equipment_types q
 WHERE e.equipment_id IS NULL
   AND e.equipment IS NOT NULL
   AND lower(q.name) = lower(e.equipment);

-- 94 rows imported with no equipment. They are bodyweight stretches and
-- mobility drills; "unknown" is not a useful filter value, "Bodyweight" is.
UPDATE exercises e
   SET equipment_id = q.id
  FROM equipment_types q
 WHERE e.equipment_id IS NULL
   AND q.slug = 'bodyweight';


-- ─── CATEGORY FK ─────────────────────────────────────────────
UPDATE exercises e
   SET category_id = c.id
  FROM exercise_categories c
 WHERE e.category_id IS NULL
   AND e.exercise_type IS NOT NULL
   AND lower(c.name) = lower(e.exercise_type);

UPDATE exercises e
   SET category_id = c.id
  FROM exercise_categories c
 WHERE e.category_id IS NULL
   AND c.slug = 'strength';


-- ─── EXERCISE ↔ MUSCLE JOIN ──────────────────────────────────
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT e.id, e.primary_muscle_id, 'primary'
  FROM exercises e
 WHERE e.primary_muscle_id IS NOT NULL
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;

-- `secondary_muscles` is a comma-joined blob ("glutes, hamstrings, shoulders").
-- Unnesting it here is the whole reason the join table exists: until now
-- "which exercises also work the glutes" was not an answerable question.
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT DISTINCT e.id, m.id, 'secondary'
  FROM exercises e
 CROSS JOIN LATERAL unnest(string_to_array(e.secondary_muscles, ',')) AS part(raw)
  JOIN muscles m
    ON m.slug = trim(BOTH '-' FROM regexp_replace(lower(trim(part.raw)), '[^a-z0-9]+', '-', 'g'))
 WHERE e.secondary_muscles IS NOT NULL
   AND e.secondary_muscles <> ''
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;


-- ─── MOVEMENT PATTERN ────────────────────────────────────────
-- Derived from the exercise name, which is the only signal the source dataset
-- carries. Ordered most-specific first: "Barbell Front Squat" must match
-- Squat before the generic press/pull checks get a chance.
UPDATE exercises SET movement_pattern = CASE
  WHEN name ILIKE '%lunge%' OR name ILIKE '%split squat%' OR name ILIKE '%step up%'
    OR name ILIKE '%step-up%'                                        THEN 'Lunge'
  WHEN name ILIKE '%squat%'                                          THEN 'Squat'
  WHEN name ILIKE '%deadlift%' OR name ILIKE '%good morning%'
    OR name ILIKE '%hip thrust%' OR name ILIKE '%back extension%'
    OR name ILIKE '%romanian%' OR name ILIKE '%swing%'                THEN 'Hinge'
  WHEN name ILIKE '%pull up%' OR name ILIKE '%pull-up%' OR name ILIKE '%pullup%'
    OR name ILIKE '%chin up%' OR name ILIKE '%chin-up%'
    OR name ILIKE '%pulldown%' OR name ILIKE '%pull down%'            THEN 'Vertical Pull'
  WHEN name ILIKE '%row%'                                            THEN 'Horizontal Pull'
  WHEN name ILIKE '%overhead press%' OR name ILIKE '%shoulder press%'
    OR name ILIKE '%military press%' OR name ILIKE '%push press%'
    OR name ILIKE '%jerk%'                                           THEN 'Vertical Push'
  WHEN name ILIKE '%bench press%' OR name ILIKE '%push up%' OR name ILIKE '%push-up%'
    OR name ILIKE '%pushup%' OR name ILIKE '%dip%' OR name ILIKE '%chest press%' THEN 'Horizontal Push'
  WHEN name ILIKE '%carry%' OR name ILIKE '%farmer%'                 THEN 'Carry'
  WHEN name ILIKE '%twist%' OR name ILIKE '%rotation%'
    OR name ILIKE '%woodchop%' OR name ILIKE '%russian%'              THEN 'Rotation'
  WHEN name ILIKE '%plank%' OR name ILIKE '%hollow%' OR name ILIKE '%dead bug%'
    OR name ILIKE '%pallof%'                                         THEN 'Anti-Extension'
  WHEN name ILIKE '%crunch%' OR name ILIKE '%sit up%' OR name ILIKE '%sit-up%'
    OR name ILIKE '%leg raise%'                                      THEN 'Trunk Flexion'
  WHEN name ILIKE '%curl%' OR name ILIKE '%extension%' OR name ILIKE '%raise%'
    OR name ILIKE '%fly%' OR name ILIKE '%flye%' OR name ILIKE '%kickback%'   THEN 'Isolation'
  WHEN name ILIKE '%stretch%' OR name ILIKE '%mobility%'             THEN 'Mobility'
  WHEN name ILIKE '%run%' OR name ILIKE '%bike%' OR name ILIKE '%row machine%'
    OR name ILIKE '%jump rope%' OR name ILIKE '%sprint%'              THEN 'Locomotion'
  ELSE 'General'
END
WHERE movement_pattern IS NULL;


-- ─── PLANE OF MOTION ─────────────────────────────────────────
UPDATE exercises SET plane_of_motion = CASE
  WHEN name ILIKE '%lateral raise%' OR name ILIKE '%side lateral%'
    OR name ILIKE '%side lunge%'    OR name ILIKE '%lateral lunge%'
    OR name ILIKE '%abduction%'     OR name ILIKE '%adduction%'
    OR name ILIKE '%side bend%'                                      THEN 'Frontal'
  WHEN name ILIKE '%twist%' OR name ILIKE '%rotation%' OR name ILIKE '%woodchop%'
    OR name ILIKE '%fly%'   OR name ILIKE '%flye%'                    THEN 'Transverse'
  ELSE 'Sagittal'
END
WHERE plane_of_motion IS NULL;


-- ─── SEARCH KEYWORDS ─────────────────────────────────────────
-- Feeds the weight-B lane of search_vector. Two jobs: fold in the taxonomy
-- words that are not in the name, and add the shorthand a trainer actually
-- types — nobody searches "dumbbell incline bench press", they type "db incl".
UPDATE exercises e SET search_keywords = trim(concat_ws(' ',
  e.name,
  e.target_muscle,
  replace(coalesce(e.secondary_muscles, ''), ',', ' '),
  e.equipment,
  e.exercise_type,
  e.muscle_group,
  e.mechanic,
  e.force,
  e.movement_pattern,
  CASE WHEN e.equipment ILIKE 'dumbbell'        THEN 'db'  END,
  CASE WHEN e.equipment ILIKE 'barbell'         THEN 'bb'  END,
  CASE WHEN e.equipment ILIKE 'kettlebell'      THEN 'kb'  END,
  CASE WHEN e.equipment ILIKE 'resistance band' THEN 'band' END,
  CASE WHEN e.equipment ILIKE 'bodyweight'      THEN 'bw calisthenics' END,
  CASE WHEN e.name ILIKE '%incline%'            THEN 'incl' END,
  CASE WHEN e.name ILIKE '%decline%'            THEN 'decl' END,
  CASE WHEN e.name ILIKE '%romanian deadlift%'  THEN 'rdl' END,
  CASE WHEN e.name ILIKE '%overhead%'           THEN 'ohp' END,
  CASE WHEN e.mechanic = 'compound'             THEN 'compound multi-joint' END,
  CASE WHEN e.mechanic = 'isolation'            THEN 'isolation single-joint' END
))
WHERE e.search_keywords IS NULL;


-- ─── PRESCRIPTION DEFAULTS ───────────────────────────────────
-- Rep ranges that match how the exercise is actually loaded, so a new
-- programme starts from something defensible instead of a blank field.
UPDATE exercises SET
  recommended_sets = CASE
    WHEN exercise_type IN ('stretching')                  THEN '1-2'
    WHEN mechanic = 'compound'                            THEN '3-5'
    ELSE '3-4' END,
  recommended_reps = CASE
    WHEN exercise_type = 'stretching'                     THEN '30-60s hold'
    WHEN exercise_type = 'cardio'                         THEN '15-30 min'
    WHEN exercise_type IN ('powerlifting','olympic weightlifting') THEN '3-5'
    WHEN exercise_type = 'plyometrics'                    THEN '3-8'
    WHEN mechanic = 'compound'                            THEN '6-10'
    ELSE '10-15' END
WHERE recommended_reps IS NULL;


-- ─── LIFECYCLE DEFAULTS ──────────────────────────────────────
-- Everything imported is the shared built-in library: public, org-agnostic,
-- not custom. Explicit rather than relying on column defaults, so a re-run
-- after a partial failure lands in the same state.
UPDATE exercises
   SET is_custom  = FALSE,
       visibility = 'public'
 WHERE source_id IS NOT NULL
   AND is_custom IS DISTINCT FROM FALSE;


-- ─── THE ORIGINAL TWELVE ─────────────────────────────────────
-- These predate the free-exercise-db import: hand-seeded basics with no
-- source_id and no target_muscle, so every heuristic above skipped them.
-- They also happen to be what the live workout plans actually reference, so
-- they get an explicit mapping rather than a coarse muscle_group fallback —
-- "Deadlift → Legs" is not a useful answer to "what does this train".
UPDATE exercises e
   SET primary_muscle_id = m.id
  FROM muscles m, (VALUES
    ('Squat',             'quadriceps'),
    ('Leg Press',         'quadriceps'),
    ('Deadlift',          'hamstrings'),
    ('Barbell Row',       'middle-back'),
    ('Pull Ups',          'lats'),
    ('Lat Pulldown',      'lats'),
    ('Plank',             'abdominals'),
    ('Cable Crunch',      'abdominals'),
    ('Bicep Curl',        'biceps'),
    ('Tricep Pushdown',   'triceps'),
    ('Treadmill Running', 'cardiovascular'),
    ('Jump Rope',         'cardiovascular')
  ) AS map(ex_name, muscle_slug)
 WHERE e.primary_muscle_id IS NULL
   AND e.name = map.ex_name
   AND m.slug = map.muscle_slug;

-- Re-run so the twelve get their primary join row too.
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT e.id, e.primary_muscle_id, 'primary'
  FROM exercises e
 WHERE e.primary_muscle_id IS NOT NULL
ON CONFLICT (exercise_id, muscle_id) DO NOTHING;

UPDATE exercises e SET search_keywords = trim(concat_ws(' ',
  e.name, e.target_muscle, e.equipment, e.exercise_type, e.muscle_group,
  e.mechanic, e.force, e.movement_pattern))
 WHERE e.search_keywords IS NULL OR e.search_keywords = '';


ALTER TABLE exercises ENABLE TRIGGER exercises_version_history;
