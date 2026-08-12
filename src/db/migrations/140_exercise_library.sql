-- ============================================================
-- 140_exercise_library.sql
-- The Exercise Library, rebuilt as the single source of truth.
--
-- WHY THIS EVOLVES `exercises` RATHER THAN REPLACING IT
-- ----------------------------------------------------
-- `workout_exercises.exercise_id` and `workout_session_exercises.exercise_id`
-- point at `exercises.id`, and the former does so ON DELETE CASCADE. Building
-- a parallel table and repointing those FKs would put real client programmes
-- and logged training history through a remap step for no benefit: the 890
-- rows already there ARE the library we want to keep. So every id survives,
-- every existing plan keeps resolving, and "replacement" happens by giving the
-- table the shape a professional library needs — not by emptying it.
--
-- WHAT IS ADDED
--   1. The full coaching detail set (cues, mistakes, safety, tempo, notes …)
--   2. Normalized muscle / equipment / category lookups, because
--      `secondary_muscles` was a comma-joined TEXT blob nothing could filter on
--   3. Exercise-to-exercise relations (progression / regression / alternative)
--   4. Full-text search (weighted tsvector + GIN) and trigram fuzzy name match
--   5. Version history, captured by trigger so no writer can forget it
--   6. Per-user favorites and recently-used
--   7. Soft delete + archive + visibility
--
-- BACKWARD COMPATIBILITY
-- The legacy flat columns (`target_muscle`, `equipment`, `exercise_type` …)
-- are NOT dropped. routes/workouts.js joins against them today. A trigger
-- keeps them in sync with the new FK columns, so old queries stay correct
-- without being rewritten, and there is exactly one place where the two
-- representations can drift: `exercises_sync_legacy_columns()`.
-- ============================================================

-- ─── EXTENSIONS ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;


-- ─── LOOKUP: MUSCLES ─────────────────────────────────────────
-- `body_region` is what the UI groups by and what the legacy
-- `exercises.muscle_group` CHECK constraint already accepts, so the mapping
-- from a specific muscle up to a filter bucket lives in data, not in code.
CREATE TABLE IF NOT EXISTS muscles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  body_region TEXT NOT NULL
              CHECK (body_region IN ('Chest','Back','Legs','Shoulders','Arms','Core','Cardio','Full Body')),
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS muscles_region_idx ON muscles (body_region, sort_order);


-- ─── LOOKUP: EQUIPMENT ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_types (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  -- Lets a trainer filter "what can this client actually do at home".
  is_gym_only BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── LOOKUP: CATEGORIES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS exercise_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── EXERCISES: THE NEW COLUMNS ──────────────────────────────
-- Identity / classification
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS slug             TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS primary_muscle_id UUID REFERENCES muscles(id) ON DELETE SET NULL;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS equipment_id     UUID REFERENCES equipment_types(id) ON DELETE SET NULL;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS category_id      UUID REFERENCES exercise_categories(id) ON DELETE SET NULL;

-- Biomechanics. `force` and `mechanic` already exist from the original import;
-- these two complete the picture a programme designer reasons about.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS movement_pattern TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS plane_of_motion  TEXT;

-- Coaching content. Arrays rather than prose: the UI renders these as
-- checklists, and a trainer edits them one bullet at a time.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS coaching_cues    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS common_mistakes  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS safety_tips      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS contraindications TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS breathing_tips   TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS tempo_recommendation TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS beginner_notes   TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS advanced_notes   TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS trainer_notes    TEXT;

-- Prescription defaults. TEXT, not INT: real programming says "8-12", not 10.
-- `sets_default` / `reps_default` / `rest_seconds` already exist and stay the
-- numeric fallback the Workout Builder seeds a set row from.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS recommended_reps TEXT;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS recommended_sets TEXT;

-- Discovery
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS tags            TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS search_keywords TEXT;

-- Lifecycle. Soft delete only — a hard DELETE would cascade into
-- workout_exercises and silently rewrite a client's programme.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS visibility  TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public','organization','private'));
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS version     INT NOT NULL DEFAULT 1;

-- Tenancy. NULL = the shared built-in library (see 086_workouts_organization_id:
-- the plan library is deliberately global). Non-NULL = a studio's own custom
-- exercise, visible only to them.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS is_custom       BOOLEAN NOT NULL DEFAULT FALSE;


-- ─── JOIN: EXERCISE ↔ MUSCLES ────────────────────────────────
-- Replaces the comma-joined `secondary_muscles` TEXT blob. `role` carries
-- primary vs secondary so one table answers both "what does this train" and
-- "which exercises hit this muscle at all".
CREATE TABLE IF NOT EXISTS exercise_muscles (
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  muscle_id   UUID NOT NULL REFERENCES muscles(id)   ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  PRIMARY KEY (exercise_id, muscle_id)
);
CREATE INDEX IF NOT EXISTS exercise_muscles_muscle_idx ON exercise_muscles (muscle_id, role);


-- ─── EXERCISE ↔ EXERCISE RELATIONS ───────────────────────────
-- Progressions, regressions and swaps. Self-referential rather than a TEXT
-- list so "show me easier options" is a join, and renaming an exercise can
-- never orphan the reference.
CREATE TABLE IF NOT EXISTS exercise_relations (
  exercise_id         TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  related_exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  relation_type       TEXT NOT NULL CHECK (relation_type IN ('progression','regression','alternative')),
  sort_order          INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (exercise_id, related_exercise_id, relation_type),
  CHECK (exercise_id <> related_exercise_id)
);
CREATE INDEX IF NOT EXISTS exercise_relations_related_idx ON exercise_relations (related_exercise_id, relation_type);


-- ─── VERSION HISTORY ─────────────────────────────────────────
-- Written by trigger, not by the API layer: an edit path that forgets to
-- snapshot is the only way history goes wrong, so no edit path is trusted
-- with the decision.
CREATE TABLE IF NOT EXISTS exercise_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id    TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  version        INT  NOT NULL,
  snapshot       JSONB NOT NULL,
  changed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  change_summary TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exercise_id, version)
);
CREATE INDEX IF NOT EXISTS exercise_versions_lookup_idx ON exercise_versions (exercise_id, version DESC);


-- ─── FAVORITES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exercise_favorites (
  user_id     TEXT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, exercise_id)
);
CREATE INDEX IF NOT EXISTS exercise_favorites_user_idx ON exercise_favorites (user_id, created_at DESC);


-- ─── RECENTLY USED ───────────────────────────────────────────
-- Upserted whenever an exercise is added to a programme. `use_count` lets the
-- picker rank "what this trainer actually programmes" above raw recency.
CREATE TABLE IF NOT EXISTS exercise_recent_usage (
  user_id     TEXT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  use_count   INT  NOT NULL DEFAULT 1,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, exercise_id)
);
CREATE INDEX IF NOT EXISTS exercise_recent_user_idx ON exercise_recent_usage (user_id, used_at DESC);


-- ─── FULL-TEXT SEARCH ────────────────────────────────────────
-- Weighted so a name match outranks an equipment match. GENERATED means it can
-- never fall out of step with the row — there is no "reindex" path to forget.
-- The two-argument to_tsvector() is required: the one-argument form is only
-- STABLE (it reads default_text_search_config) and a generated column needs
-- IMMUTABLE.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')),              'A') ||
    setweight(to_tsvector('english', coalesce(search_keywords, '')),   'B') ||
    setweight(to_tsvector('english', coalesce(target_muscle, '')),     'B') ||
    setweight(to_tsvector('english', coalesce(secondary_muscles, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(equipment, '')),         'C') ||
    setweight(to_tsvector('english', coalesce(body_part, '')),         'C') ||
    setweight(to_tsvector('english', coalesce(description, '')),       'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS exercises_search_vector_idx ON exercises USING GIN (search_vector);
-- Trigram index for typo-tolerant / substring name matching, which tsvector
-- does not do ("bech press", "incl db").
CREATE INDEX IF NOT EXISTS exercises_name_trgm_idx ON exercises USING GIN (name gin_trgm_ops);


-- ─── INDEXES ─────────────────────────────────────────────────
-- Partial on the live set: every list query filters deleted rows out, so the
-- index should not carry them.
CREATE UNIQUE INDEX IF NOT EXISTS exercises_slug_key       ON exercises (slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_live_name_idx         ON exercises (name)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_primary_muscle_idx    ON exercises (primary_muscle_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_equipment_id_idx      ON exercises (equipment_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_category_id_idx       ON exercises (category_id)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_difficulty_idx        ON exercises (difficulty)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_mechanic_idx          ON exercises (mechanic)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_force_idx             ON exercises (force)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_org_idx               ON exercises (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_archived_idx          ON exercises (archived_at)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exercises_tags_idx              ON exercises USING GIN (tags);
-- Default sort of the library is alphabetical over the live, unarchived set.
CREATE INDEX IF NOT EXISTS exercises_library_sort_idx      ON exercises (name)
  WHERE deleted_at IS NULL AND archived_at IS NULL;


-- ─── TRIGGER: KEEP LEGACY FLAT COLUMNS IN SYNC ───────────────
-- The one place the normalized and denormalized representations meet.
-- Deliberately only ever WRITES a legacy value when the FK is present — it
-- never nulls one out, so a row imported before normalization keeps its text.
CREATE OR REPLACE FUNCTION exercises_sync_legacy_columns() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.primary_muscle_id IS NOT NULL THEN
    SELECT m.name, m.body_region INTO NEW.target_muscle, NEW.muscle_group
      FROM muscles m WHERE m.id = NEW.primary_muscle_id;
    NEW.body_part := NEW.muscle_group;
  END IF;

  IF NEW.equipment_id IS NOT NULL THEN
    SELECT e.name INTO NEW.equipment FROM equipment_types e WHERE e.id = NEW.equipment_id;
  END IF;

  IF NEW.category_id IS NOT NULL THEN
    SELECT c.name INTO NEW.exercise_type FROM exercise_categories c WHERE c.id = NEW.category_id;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exercises_sync_legacy ON exercises;
CREATE TRIGGER exercises_sync_legacy
  BEFORE INSERT OR UPDATE ON exercises
  FOR EACH ROW EXECUTE FUNCTION exercises_sync_legacy_columns();


-- ─── TRIGGER: VERSION HISTORY ────────────────────────────────
-- Snapshots the row as it was BEFORE the edit, and bumps the version counter.
-- Skips no-op writes and skips pure soft-delete/restore flips, which are
-- lifecycle events rather than content edits and would otherwise bury the
-- real history under noise.
CREATE OR REPLACE FUNCTION exercises_capture_version() RETURNS TRIGGER AS $$
BEGIN
  IF to_jsonb(OLD) - 'updated_at' - 'version' - 'search_vector'
   = to_jsonb(NEW) - 'updated_at' - 'version' - 'search_vector' THEN
    RETURN NEW;
  END IF;

  INSERT INTO exercise_versions (exercise_id, version, snapshot, changed_by)
  VALUES (OLD.id, OLD.version, to_jsonb(OLD) - 'search_vector', NEW.updated_by)
  ON CONFLICT (exercise_id, version) DO NOTHING;

  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exercises_version_history ON exercises;
CREATE TRIGGER exercises_version_history
  BEFORE UPDATE ON exercises
  FOR EACH ROW EXECUTE FUNCTION exercises_capture_version();


-- ─── PROTECT PROGRAMMES FROM EXERCISE DELETION ───────────────
-- `workout_exercises.exercise_id` was ON DELETE CASCADE: deleting one exercise
-- would silently strip it from every client programme that used it. The
-- library soft-deletes now, so a hard DELETE reaching this FK is a bug — make
-- the database refuse it rather than quietly rewrite training history.
DO $$
DECLARE fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'workout_exercises'
     AND con.contype = 'f'
     AND con.confrelid = 'exercises'::regclass
   LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE workout_exercises DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE workout_exercises
    ADD CONSTRAINT workout_exercises_exercise_id_fkey
    FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE RESTRICT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'workout_exercises FK hardening skipped: %', SQLERRM;
END $$;


-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- Every table this migration creates is denied to PostgREST.
--
-- These reach the API only through routes/exercises.js, which applies the
-- tenant and visibility rules. Without this block they would also be readable
-- directly with the publishable key, which would hand any client app the full
-- exercise catalogue plus every trainer's favorites and usage history —
-- bypassing the API and the org scoping inside it.
--
-- See src/__tests__/rls.convention.test.js: this is enforced on the branch,
-- not discovered in production.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'muscles', 'equipment_types', 'exercise_categories',
    'exercise_muscles', 'exercise_relations', 'exercise_versions',
    'exercise_favorites', 'exercise_recent_usage'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I FOR ALL USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;


-- ─── SEED: CATEGORIES ────────────────────────────────────────
-- Names match the values already in `exercises.exercise_type` so the backfill
-- is a straight join rather than a translation table.
INSERT INTO exercise_categories (name, slug, sort_order) VALUES
  ('Strength',              'strength',              1),
  ('Powerlifting',          'powerlifting',          2),
  ('Olympic Weightlifting', 'olympic-weightlifting', 3),
  ('Strongman',             'strongman',             4),
  ('Plyometrics',           'plyometrics',           5),
  ('Cardio',                'cardio',                6),
  ('Stretching',            'stretching',            7),
  ('Mobility',              'mobility',              8),
  ('Rehabilitation',        'rehabilitation',        9)
ON CONFLICT (slug) DO NOTHING;


-- ─── SEED: EQUIPMENT ─────────────────────────────────────────
INSERT INTO equipment_types (name, slug, is_gym_only, sort_order) VALUES
  ('Bodyweight',      'bodyweight',      FALSE, 1),
  ('Barbell',         'barbell',         TRUE,  2),
  ('Dumbbell',        'dumbbell',        FALSE, 3),
  ('Kettlebell',      'kettlebell',      FALSE, 4),
  ('Machine',         'machine',         TRUE,  5),
  ('Cable',           'cable',           TRUE,  6),
  ('Smith Machine',   'smith-machine',   TRUE,  7),
  ('EZ Curl Bar',     'ez-curl-bar',     TRUE,  8),
  ('Resistance Band', 'resistance-band', FALSE, 9),
  ('Medicine Ball',   'medicine-ball',   FALSE, 10),
  ('Exercise Ball',   'exercise-ball',   FALSE, 11),
  ('Foam Roller',     'foam-roller',     FALSE, 12),
  ('Landmine',        'landmine',        TRUE,  13),
  ('Trap Bar',        'trap-bar',        TRUE,  14),
  ('Suspension Trainer', 'suspension-trainer', FALSE, 15),
  ('Other',           'other',           FALSE, 99)
ON CONFLICT (slug) DO NOTHING;


-- ─── SEED: MUSCLES ───────────────────────────────────────────
-- Covers the 17 distinct `target_muscle` values already in the table plus the
-- ones a trainer expects to be able to pick when authoring a custom exercise.
INSERT INTO muscles (name, slug, body_region, sort_order) VALUES
  ('Chest',            'chest',            'Chest',     1),
  ('Upper Chest',      'upper-chest',      'Chest',     2),
  ('Lats',             'lats',             'Back',      10),
  ('Middle Back',      'middle-back',      'Back',      11),
  ('Lower Back',       'lower-back',       'Back',      12),
  ('Traps',            'traps',            'Back',      13),
  ('Neck',             'neck',             'Back',      14),
  ('Quadriceps',       'quadriceps',       'Legs',      20),
  ('Hamstrings',       'hamstrings',       'Legs',      21),
  ('Glutes',           'glutes',           'Legs',      22),
  ('Calves',           'calves',           'Legs',      23),
  ('Adductors',        'adductors',        'Legs',      24),
  ('Abductors',        'abductors',        'Legs',      25),
  ('Shoulders',        'shoulders',        'Shoulders', 30),
  ('Front Delts',      'front-delts',      'Shoulders', 31),
  ('Side Delts',       'side-delts',       'Shoulders', 32),
  ('Rear Delts',       'rear-delts',       'Shoulders', 33),
  ('Biceps',           'biceps',           'Arms',      40),
  ('Triceps',          'triceps',          'Arms',      41),
  ('Forearms',         'forearms',         'Arms',      42),
  ('Abdominals',       'abdominals',       'Core',      50),
  ('Obliques',         'obliques',         'Core',      51),
  ('Cardiovascular',   'cardiovascular',   'Cardio',    60),
  ('Full Body',        'full-body',        'Full Body', 70)
ON CONFLICT (slug) DO NOTHING;
