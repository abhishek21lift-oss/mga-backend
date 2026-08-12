/**
 * Exercise Library import utility.
 *
 * Imports a JSON dataset (free-exercise-db shape) into the normalized
 * Exercise Library and leaves every imported row fully filterable: slugged,
 * FK-resolved to muscles/equipment/category, joined into exercise_muscles,
 * and keyword-indexed for full-text search.
 *
 * Usage:
 *   node scripts/import-exercises.js [path/to/exercises.json] [--dry-run]
 *
 * Safe to re-run. Existing rows are matched on source_id first and name
 * second, then enriched rather than duplicated — a second run of the same
 * file inserts nothing.
 *
 * WHY THE NORMALIZATION STEP IS NOT WRITTEN HERE
 * The mapping from "middle back" to the Middle Back muscle row (and the slug,
 * keyword and prescription-default rules) already exists, in
 * migrations/141_exercise_library_backfill.sql. That file is idempotent and
 * only ever fills columns that are still NULL, so this script executes it
 * verbatim after loading. One implementation, so an importer and a migration
 * can never disagree about what "normalized" means.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const pool = require('../src/db/pool');

const BACKFILL_SQL = path.join(__dirname, '..', 'src', 'db', 'migrations', '141_exercise_library_backfill.sql');

const BODY_PART_MAP = {
  abdominals: 'Core',      obliques: 'Core',
  hamstrings: 'Legs',      adductors: 'Legs',   quadriceps: 'Legs',
  glutes:     'Legs',      calves:    'Legs',   abductors:  'Legs',
  biceps:     'Arms',      triceps:   'Arms',   forearms:   'Arms',
  shoulders:  'Shoulders', chest:     'Chest',
  'middle back': 'Back',   'lower back': 'Back',
  lats:       'Back',      traps:     'Back',   neck:       'Back',
};

const EQUIPMENT_MAP = {
  'body only': 'Bodyweight', machine: 'Machine',   dumbbell: 'Dumbbell',
  barbell:     'Barbell',    kettlebells: 'Kettlebell', cable: 'Cable',
  bands:       'Resistance Band', 'medicine ball': 'Medicine Ball',
  'exercise ball': 'Exercise Ball', 'foam roll': 'Foam Roller',
  'e-z curl bar': 'EZ Curl Bar', other: 'Other', none: 'Bodyweight',
};

const DIFFICULTY_MAP = {
  beginner: 'beginner', intermediate: 'intermediate', expert: 'advanced', advanced: 'advanced',
};

const VALID_DIFFICULTY = new Set(['beginner', 'intermediate', 'advanced']);
// Retained so re-importing does not blank gif_url on the 873 rows that have
// one. The Exercise Library UI no longer renders media of any kind — the data
// is kept, not shown.
const BASE_IMAGE_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

/**
 * Maps one dataset record onto the flat columns.
 * Returns null when the record cannot be trusted — a nameless exercise is not
 * a row worth having, and silently importing it would put an unlabelled card
 * in front of a trainer.
 */
function normalize(ex) {
  const rawName = String(ex?.name || '').trim();
  if (!rawName) return null;

  const primaryMuscle = Array.isArray(ex.primaryMuscles) && ex.primaryMuscles.length
    ? String(ex.primaryMuscles[0]).toLowerCase()
    : null;

  const difficulty = DIFFICULTY_MAP[String(ex.level || '').toLowerCase()] || 'beginner';

  return {
    source_id:        ex.id ? String(ex.id) : null,
    name:             rawName.charAt(0).toUpperCase() + rawName.slice(1),
    muscle_group:     BODY_PART_MAP[primaryMuscle] || 'Full Body',
    body_part:        BODY_PART_MAP[primaryMuscle] || 'Full Body',
    target_muscle:    primaryMuscle,
    secondary_muscles: Array.isArray(ex.secondaryMuscles) && ex.secondaryMuscles.length
      ? ex.secondaryMuscles.join(', ') : null,
    equipment:    EQUIPMENT_MAP[String(ex.equipment || '').toLowerCase()] || ex.equipment || null,
    difficulty:   VALID_DIFFICULTY.has(difficulty) ? difficulty : 'beginner',
    instructions: Array.isArray(ex.instructions) ? ex.instructions.join('\n') : (ex.instructions || null),
    gif_url:      Array.isArray(ex.images) && ex.images.length ? `${BASE_IMAGE_URL}/${ex.images[0]}` : null,
    exercise_type: ex.category || null,
    force:        ex.force || null,
    mechanic:     ex.mechanic || null,
  };
}

async function run() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const argPath = args.find((a) => !a.startsWith('--'));
  const rawPath = argPath
    ? path.resolve(argPath)
    : path.join(__dirname, '..', '..', 'exercises_raw.json');

  if (!fs.existsSync(rawPath)) {
    console.error(`Dataset not found: ${rawPath}`);
    console.error('Pass a path: node scripts/import-exercises.js ./exercises.json');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  } catch (err) {
    console.error(`Could not parse ${rawPath}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error('Dataset must be a JSON array of exercise objects.');
    process.exit(1);
  }

  console.log(`Loaded ${raw.length} records from ${path.basename(rawPath)}`);
  if (dryRun) console.log('DRY RUN — no writes will be committed\n');

  const { rows: existing } = await pool.query(
    'SELECT id, name, source_id FROM exercises WHERE deleted_at IS NULL'
  );
  const byName     = new Map(existing.map((r) => [r.name.toLowerCase(), r.id]));
  const bySourceId = new Map(existing.filter((r) => r.source_id).map((r) => [r.source_id, r.id]));

  let inserted = 0, updated = 0, invalid = 0;
  const errors = [];
  // Guards against a dataset that repeats a name within its own file, which
  // would otherwise insert a duplicate on the first run.
  const seenThisRun = new Set();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const record of raw) {
      const n = normalize(record);
      if (!n) { invalid++; continue; }

      const key = n.name.toLowerCase();
      if (seenThisRun.has(key)) { invalid++; continue; }
      seenThisRun.add(key);

      try {
        const existingId = (n.source_id && bySourceId.get(n.source_id)) || byName.get(key);

        if (existingId) {
          // Enrich only. COALESCE keeps anything a trainer edited by hand:
          // an import must never overwrite human work.
          await client.query(
            `UPDATE exercises SET
               source_id         = COALESCE(source_id, $1),
               target_muscle     = COALESCE(target_muscle, $2),
               secondary_muscles = COALESCE(secondary_muscles, $3),
               equipment         = COALESCE(equipment, $4),
               instructions      = COALESCE(instructions, $5),
               gif_url           = COALESCE(gif_url, $6),
               exercise_type     = COALESCE(exercise_type, $7),
               force             = COALESCE(force, $8),
               mechanic          = COALESCE(mechanic, $9)
             WHERE id = $10`,
            [n.source_id, n.target_muscle, n.secondary_muscles, n.equipment,
             n.instructions, n.gif_url, n.exercise_type, n.force, n.mechanic, existingId]
          );
          updated++;
        } else {
          const id = randomUUID();
          await client.query(
            `INSERT INTO exercises
               (id, name, muscle_group, body_part, target_muscle, secondary_muscles,
                equipment, difficulty, instructions, gif_url, exercise_type,
                force, mechanic, source_id, is_active, is_custom, visibility)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,FALSE,'public')`,
            [id, n.name, n.muscle_group, n.body_part, n.target_muscle, n.secondary_muscles,
             n.equipment, n.difficulty, n.instructions, n.gif_url, n.exercise_type,
             n.force, n.mechanic, n.source_id]
          );
          inserted++;
          byName.set(key, id);
          if (n.source_id) bySourceId.set(n.source_id, id);
        }
      } catch (err) {
        errors.push({ name: n.name, error: err.message });
      }
    }

    // Normalize everything the import just touched — slugs, FKs, muscle join
    // rows, keywords, prescription defaults. Idempotent, so rows that were
    // already normalized are untouched.
    console.log('\nNormalizing…');
    const backfill = fs.readFileSync(BACKFILL_SQL, 'utf8');
    await client.query(backfill);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Rolled back (dry run).');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const { rows: [stats] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE slug IS NULL)::int              AS missing_slug,
            COUNT(*) FILTER (WHERE primary_muscle_id IS NULL)::int AS missing_muscle,
            COUNT(*) FILTER (WHERE equipment_id IS NULL)::int      AS missing_equipment
       FROM exercises WHERE deleted_at IS NULL`
  );

  console.log('\n=== Exercise Import Complete ===');
  console.log(`  Inserted        : ${inserted}`);
  console.log(`  Updated         : ${updated}`);
  console.log(`  Invalid/skipped : ${invalid}`);
  console.log(`  Errors          : ${errors.length}`);
  console.log('\n=== Library State ===');
  console.log(`  Total exercises   : ${stats.total}`);
  console.log(`  Missing slug      : ${stats.missing_slug}`);
  console.log(`  Missing muscle    : ${stats.missing_muscle}`);
  console.log(`  Missing equipment : ${stats.missing_equipment}`);

  if (errors.length) {
    console.log('\nErrors:');
    errors.slice(0, 20).forEach((e) => console.log(`  ${e.name}: ${e.error}`));
    if (errors.length > 20) console.log(`  … and ${errors.length - 20} more`);
  }

  await pool.end();
  if (stats.missing_slug || stats.missing_muscle) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  pool.end().finally(() => process.exit(1));
});
