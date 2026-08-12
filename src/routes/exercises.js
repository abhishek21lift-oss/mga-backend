// src/routes/exercises.js — The Exercise Library.
//
// This is the single source of truth for exercises. The older endpoints under
// /api/workouts/exercises remain mounted and now delegate here in spirit: they
// read the same table, but every new capability (full-text search, favorites,
// recents, versions, archive, relations) lives in this file so there is one
// place to reason about permissions.
//
// PERMISSION MODEL
//   admin / manager / super_admin  full access to every exercise
//   trainer                        read all; create custom; edit only their own
//   reception / member             read only
//
// Ownership is checked against the row, not the role alone — see canEdit().

const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// ─── PERMISSIONS ──────────────────────────────────────────────

const FULL_ACCESS = new Set(['super_admin', 'admin', 'manager']);

/** May create a custom exercise at all. */
function canCreate(user) {
  return FULL_ACCESS.has(user?.role) || user?.role === 'trainer';
}

/**
 * May edit/archive/delete THIS row.
 *
 * A trainer owns what they authored and nothing else. Critically, nobody
 * except full-access roles may edit a built-in library exercise (one with a
 * source_id and no organization): a trainer editing "Barbell Squat" would
 * silently change it for every other studio on the platform.
 */
function canEdit(user, row) {
  if (FULL_ACCESS.has(user?.role)) return true;
  if (user?.role !== 'trainer') return false;
  return row.created_by === user.id && row.is_custom === true;
}

function forbid(res, msg = 'You do not have permission to modify this exercise') {
  return res.status(403).json({ error: msg });
}

// ─── HELPERS ──────────────────────────────────────────────────

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Free-text array field from the client: trims, drops blanks, caps length. */
function textArray(v, max = 25) {
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);
}

function nullableText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

const DIFFICULTIES = new Set(['beginner', 'intermediate', 'advanced']);
const SORTS = {
  name:        'e.name ASC',
  name_desc:   'e.name DESC',
  updated:     'e.updated_at DESC',
  created:     'e.created_at DESC',
};

/**
 * The tenancy predicate every read goes through.
 *
 * Two kinds of exercise, two rules:
 *
 *   Built-in (organization_id IS NULL) — the 890-row seeded library, shared by
 *   every studio. Nobody owns these and everybody sees them.
 *
 *   Custom (organization_id set) — visible ONLY to the trainer who wrote it,
 *   and only inside their own organisation. A trainer's custom work is their
 *   own: their cues, their naming, their half-finished experiments. Another
 *   trainer in the same studio does not see them, and no other studio can
 *   reach them at all.
 *
 * This replaced a three-way `visibility` column ('public' / 'organization' /
 * 'private') that let an author widen the audience. The column still exists —
 * dropping it is a migration for no gain — but nothing reads it any more, so
 * there is no value anyone could set that would share a custom exercise. The
 * ownership check is here rather than in the handlers precisely so list, count
 * and facet queries cannot drift apart about who may see what.
 *
 * created_by is NULL on the seeded rows, which is why the ownership test sits
 * inside the custom branch — a NULL author must never match a real user.
 */
function visibilityClause(req, params) {
  const { orgId } = tenantScope(req);
  params.push(orgId);
  const orgP = `$${params.length}`;
  params.push(req.user.id);
  const userP = `$${params.length}`;
  return `(
            e.organization_id IS NULL
            OR (e.organization_id = ${orgP}::uuid AND e.created_by = ${userP})
          )`;
}

/** Shared column list for list/detail responses. One list, one source. */
const EXERCISE_COLUMNS = `
  e.id, e.name, e.slug, e.description,
  e.muscle_group, e.body_part, e.target_muscle, e.secondary_muscles,
  e.equipment, e.difficulty, e.exercise_type, e.force, e.mechanic,
  e.movement_pattern, e.plane_of_motion,
  e.instructions, e.coaching_cues, e.common_mistakes, e.safety_tips,
  e.contraindications, e.breathing_tips, e.tempo_recommendation,
  e.recommended_reps, e.recommended_sets,
  e.beginner_notes, e.advanced_notes, e.trainer_notes,
  e.sets_default, e.reps_default, e.rest_seconds,
  e.tags, e.search_keywords, e.visibility, e.is_custom,
  e.archived_at, e.deleted_at, e.version,
  e.primary_muscle_id, e.equipment_id, e.category_id, e.organization_id,
  e.created_by, e.updated_by, e.created_at, e.updated_at,
  m.name AS primary_muscle, m.slug AS primary_muscle_slug, m.body_region,
  q.name AS equipment_name, q.slug AS equipment_slug,
  c.name AS category_name, c.slug AS category_slug`;

const EXERCISE_JOINS = `
  FROM exercises e
  LEFT JOIN muscles             m ON m.id = e.primary_muscle_id
  LEFT JOIN equipment_types     q ON q.id = e.equipment_id
  LEFT JOIN exercise_categories c ON c.id = e.category_id`;

// ─── LIST / SEARCH ────────────────────────────────────────────
//
// GET /api/exercises
//   q, muscle, body_region, equipment, category, difficulty, mechanic, force,
//   pattern, tag, favorites_only, include_archived, sort, limit, offset
//
// Search runs the tsvector index first and falls back to trigram similarity in
// the same query, so "bech press" and "incl db" still land. Ordering by
// relevance only applies when there IS a query — otherwise it is alphabetical,
// which is what a browsing trainer expects.
router.get('/', auth, async (req, res, next) => {
  try {
    const params = [];
    const conds = ['e.deleted_at IS NULL'];

    conds.push(visibilityClause(req, params));

    const q = String(req.query.q || '').trim();
    let relevance = null;
    if (q) {
      params.push(q);
      const qp = `$${params.length}`;
      // websearch_to_tsquery tolerates whatever a human types — no syntax errors.
      conds.push(`(
        e.search_vector @@ websearch_to_tsquery('english', ${qp})
        OR e.name ILIKE '%' || ${qp} || '%'
        OR similarity(e.name, ${qp}) > 0.25
      )`);
      relevance = `(
        ts_rank(e.search_vector, websearch_to_tsquery('english', ${qp})) * 4
        + similarity(e.name, ${qp}) * 2
        + CASE WHEN e.name ILIKE ${qp} || '%' THEN 1 ELSE 0 END
      ) DESC`;
    }

    const eq = (col, val, cast = '') => {
      if (!val) return;
      params.push(val);
      conds.push(`${col} = $${params.length}${cast}`);
    };
    eq('m.slug',        req.query.muscle);
    eq('m.body_region', req.query.body_region);
    eq('q.slug',        req.query.equipment);
    eq('c.slug',        req.query.category);
    eq('e.difficulty',  req.query.difficulty);
    eq('e.mechanic',    req.query.mechanic);
    eq('e.force',       req.query.force);
    eq('e.movement_pattern', req.query.pattern);

    if (req.query.tag) {
      params.push(req.query.tag);
      conds.push(`e.tags @> ARRAY[$${params.length}]::text[]`);
    }

    // A muscle filter should also match exercises that hit it as a SECONDARY
    // mover — "show me everything that trains glutes" is not answerable from
    // the primary column alone. This is what exercise_muscles exists for.
    if (req.query.muscle && req.query.include_secondary === 'true') {
      conds.pop();
      params.pop();
      params.push(req.query.muscle);
      conds.push(`EXISTS (
        SELECT 1 FROM exercise_muscles em JOIN muscles mm ON mm.id = em.muscle_id
         WHERE em.exercise_id = e.id AND mm.slug = $${params.length}
      )`);
    }

    if (req.query.include_archived !== 'true') conds.push('e.archived_at IS NULL');
    if (req.query.custom_only === 'true')      conds.push('e.is_custom = TRUE');

    params.push(req.user.id);
    const favP = `$${params.length}`;
    const favSelect = `EXISTS (SELECT 1 FROM exercise_favorites f
                                WHERE f.exercise_id = e.id AND f.user_id = ${favP}) AS is_favorite`;

    if (req.query.favorites_only === 'true') {
      conds.push(`EXISTS (SELECT 1 FROM exercise_favorites f2
                           WHERE f2.exercise_id = e.id AND f2.user_id = ${favP})`);
    }

    const where = conds.join(' AND ');
    const orderBy = relevance && !req.query.sort
      ? `${relevance}, e.name ASC`
      : (SORTS[req.query.sort] || 'e.name ASC');

    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Count and page in one round trip. The window function counts the full
    // filtered set before LIMIT, so pagination knows the total without a
    // second scan of an 890-row (and growing) table.
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT ${EXERCISE_COLUMNS}, ${favSelect}, COUNT(*) OVER () AS total_count
         ${EXERCISE_JOINS}
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({
      exercises: rows.map(({ total_count, ...r }) => r),
      total,
      limit,
      offset,
      has_more: offset + rows.length < total,
    });
  } catch (err) { next(err); }
});

// ─── FACETS ───────────────────────────────────────────────────
//
// GET /api/exercises/meta — the filter rail, with live counts.
// Counts respect the caller's visibility so a studio never sees a filter
// promising results it cannot open.
router.get('/meta', auth, async (req, res, next) => {
  try {
    const params = [];
    const vis = visibilityClause(req, params);
    const base = `${EXERCISE_JOINS} WHERE e.deleted_at IS NULL AND e.archived_at IS NULL AND ${vis}`;

    const [muscles, equipment, categories, difficulties, patterns, totals] = await Promise.all([
      // ids come back alongside slugs because the exercise editor posts FKs,
      // and a second round trip just to translate a slug it already has would
      // be a round trip for nothing.
      pool.query(`SELECT m.id, m.slug, m.name, m.body_region, COUNT(*)::int AS count ${base}
                    AND m.slug IS NOT NULL GROUP BY m.id, m.slug, m.name, m.body_region, m.sort_order
                  ORDER BY m.sort_order`, params),
      pool.query(`SELECT q.id, q.slug, q.name, q.is_gym_only, COUNT(*)::int AS count ${base}
                    AND q.slug IS NOT NULL GROUP BY q.id, q.slug, q.name, q.is_gym_only, q.sort_order
                  ORDER BY q.sort_order`, params),
      pool.query(`SELECT c.id, c.slug, c.name, COUNT(*)::int AS count ${base}
                    AND c.slug IS NOT NULL GROUP BY c.id, c.slug, c.name, c.sort_order
                  ORDER BY c.sort_order`, params),
      pool.query(`SELECT e.difficulty AS slug, e.difficulty AS name, COUNT(*)::int AS count ${base}
                    AND e.difficulty IS NOT NULL GROUP BY e.difficulty`, params),
      pool.query(`SELECT e.movement_pattern AS slug, e.movement_pattern AS name, COUNT(*)::int AS count ${base}
                    AND e.movement_pattern IS NOT NULL GROUP BY e.movement_pattern ORDER BY 3 DESC`, params),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE e.is_custom)::int AS custom,
                         COUNT(*) FILTER (WHERE e.mechanic = 'compound')::int AS compound,
                         COUNT(*) FILTER (WHERE e.mechanic = 'isolation')::int AS isolation
                    ${base}`, params),
    ]);

    // The facet lists above are derived from exercises that exist, so a muscle
    // nobody has used yet is absent from them. That is right for a filter rail
    // and wrong for the editor's dropdowns — a trainer authoring the studio's
    // first neck exercise must be able to pick "Neck". These are the complete
    // lookups, unfiltered.
    const [allMuscles, allEquipment, allCategories] = await Promise.all([
      pool.query('SELECT id, slug, name, body_region FROM muscles ORDER BY sort_order'),
      pool.query('SELECT id, slug, name, is_gym_only FROM equipment_types ORDER BY sort_order'),
      pool.query('SELECT id, slug, name FROM exercise_categories ORDER BY sort_order'),
    ]);

    // Group muscles under their body region — the UI renders a two-level rail
    // ("Legs › Quadriceps") and doing the grouping here keeps that dumb.
    const byRegion = {};
    for (const m of muscles.rows) {
      (byRegion[m.body_region] ||= []).push(m);
    }

    res.json({
      muscles: muscles.rows,
      muscles_by_region: byRegion,
      equipment: equipment.rows,
      categories: categories.rows,
      difficulties: difficulties.rows,
      movement_patterns: patterns.rows,
      mechanics: [
        { slug: 'compound',  name: 'Compound',  count: totals.rows[0].compound },
        { slug: 'isolation', name: 'Isolation', count: totals.rows[0].isolation },
      ],
      forces: [
        { slug: 'push', name: 'Push' },
        { slug: 'pull', name: 'Pull' },
        { slug: 'static', name: 'Static' },
      ],
      total: totals.rows[0].total,
      custom_total: totals.rows[0].custom,
      all_muscles: allMuscles.rows,
      all_equipment: allEquipment.rows,
      all_categories: allCategories.rows,
    });
  } catch (err) { next(err); }
});

// ─── FAVORITES ────────────────────────────────────────────────

router.get('/favorites', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${EXERCISE_COLUMNS}, TRUE AS is_favorite
         ${EXERCISE_JOINS}
         JOIN exercise_favorites f ON f.exercise_id = e.id AND f.user_id = $1
        WHERE e.deleted_at IS NULL
        ORDER BY f.created_at DESC LIMIT 200`,
      [req.user.id]
    );
    res.json({ exercises: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ─── RECENTLY USED ────────────────────────────────────────────
// Ranked by recency first, then by how often this trainer reaches for it.

router.get('/recent', auth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      `SELECT ${EXERCISE_COLUMNS}, r.use_count, r.used_at,
              EXISTS (SELECT 1 FROM exercise_favorites f
                       WHERE f.exercise_id = e.id AND f.user_id = $1) AS is_favorite
         ${EXERCISE_JOINS}
         JOIN exercise_recent_usage r ON r.exercise_id = e.id AND r.user_id = $1
        WHERE e.deleted_at IS NULL AND e.archived_at IS NULL
        ORDER BY r.used_at DESC, r.use_count DESC
        LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ exercises: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ─── NAME AVAILABILITY ────────────────────────────────────────
// Powers live duplicate detection in the creator, before the user hits save.

router.get('/check-name', auth, async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.json({ available: false, reason: 'Name is required' });

    const slug = slugify(name);
    const params = [slug, name];
    let excl = '';
    if (req.query.exclude_id) { params.push(req.query.exclude_id); excl = ` AND e.id <> $3`; }

    const { rows } = await pool.query(
      `SELECT e.id, e.name FROM exercises e
        WHERE e.deleted_at IS NULL AND (e.slug = $1 OR lower(e.name) = lower($2))${excl}
        LIMIT 1`,
      params
    );
    res.json({
      available: rows.length === 0,
      slug,
      conflict: rows[0] || null,
    });
  } catch (err) { next(err); }
});

// ─── DETAIL ───────────────────────────────────────────────────

router.get('/:id', auth, async (req, res, next) => {
  try {
    const params = [req.params.id];
    const vis = visibilityClause(req, params);
    params.push(req.user.id);

    const { rows } = await pool.query(
      `SELECT ${EXERCISE_COLUMNS},
              EXISTS (SELECT 1 FROM exercise_favorites f
                       WHERE f.exercise_id = e.id AND f.user_id = $${params.length}) AS is_favorite
         ${EXERCISE_JOINS}
        WHERE (e.id = $1 OR e.slug = $1) AND e.deleted_at IS NULL AND ${vis}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Exercise not found' });
    const exercise = rows[0];

    const [muscles, relations] = await Promise.all([
      pool.query(
        `SELECT m.slug, m.name, m.body_region, em.role
           FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
          WHERE em.exercise_id = $1 ORDER BY em.role, m.sort_order`,
        [exercise.id]
      ),
      pool.query(
        `SELECT r.relation_type, e2.id, e2.name, e2.slug, e2.difficulty
           FROM exercise_relations r JOIN exercises e2 ON e2.id = r.related_exercise_id
          WHERE r.exercise_id = $1 AND e2.deleted_at IS NULL
          ORDER BY r.relation_type, r.sort_order`,
        [exercise.id]
      ),
    ]);

    exercise.muscles = muscles.rows;
    exercise.progressions  = relations.rows.filter((r) => r.relation_type === 'progression');
    exercise.regressions   = relations.rows.filter((r) => r.relation_type === 'regression');
    exercise.alternatives  = relations.rows.filter((r) => r.relation_type === 'alternative');
    exercise.can_edit      = canEdit(req.user, exercise);

    res.json(exercise);
  } catch (err) { next(err); }
});

// ─── VERSION HISTORY ──────────────────────────────────────────

router.get('/:id/versions', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.version, v.snapshot, v.change_summary, v.created_at,
              u.name AS changed_by_name
         FROM exercise_versions v
         LEFT JOIN users u ON u.id = v.changed_by
        WHERE v.exercise_id = $1
        ORDER BY v.version DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ versions: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ─── CREATE ───────────────────────────────────────────────────
//
// POST /api/exercises
// A custom exercise is always stamped with the creating studio, so "619
// Deadlift" belongs to 619 and appears nowhere else.

router.post('/', auth, async (req, res, next) => {
  if (!canCreate(req.user)) return forbid(res, 'You do not have permission to create exercises');

  const client = await pool.connect();
  try {
    const d = req.body || {};
    const name = String(d.name || '').trim();
    if (!name)             return res.status(400).json({ error: 'Exercise name is required' });
    if (name.length > 120) return res.status(400).json({ error: 'Exercise name is too long (max 120)' });
    if (d.difficulty && !DIFFICULTIES.has(d.difficulty))
      return res.status(400).json({ error: 'Invalid difficulty' });

    await client.query('BEGIN');

    // Slug uniqueness is enforced by a partial unique index; resolve it here so
    // the user gets "Landmine Squat 2" instead of a 500.
    let slug = slugify(d.slug || name);
    if (!slug) slug = `exercise-${Date.now()}`;
    const { rows: taken } = await client.query(
      `SELECT slug FROM exercises WHERE slug LIKE $1 || '%' AND deleted_at IS NULL`, [slug]
    );
    if (taken.some((t) => t.slug === slug)) {
      let n = 2;
      while (taken.some((t) => t.slug === `${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }

    const orgId = orgIdOf(req);
    const id = randomUUID();

    await client.query(
      `INSERT INTO exercises (
         id, name, slug, description, muscle_group, difficulty,
         primary_muscle_id, equipment_id, category_id,
         movement_pattern, plane_of_motion, force, mechanic,
         instructions, coaching_cues, common_mistakes, safety_tips, contraindications,
         breathing_tips, tempo_recommendation, recommended_reps, recommended_sets,
         beginner_notes, advanced_notes, trainer_notes,
         sets_default, reps_default, rest_seconds,
         tags, search_keywords, visibility, is_custom, organization_id,
         created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,COALESCE($5,'Full Body'),COALESCE($6,'beginner'),
         $7,$8,$9,$10,$11,$12,$13,$14,
         COALESCE($15,'{}'),COALESCE($16,'{}'),COALESCE($17,'{}'),COALESCE($18,'{}'),
         $19,$20,$21,$22,$23,$24,$25,
         COALESCE($26,3),COALESCE($27,12),COALESCE($28,60),
         COALESCE($29,'{}'),$30,'private',TRUE,$31,$32,$32
       )`,
      [
        id, name, slug, nullableText(d.description) ?? null,
        nullableText(d.muscle_group) ?? null, d.difficulty || null,
        d.primary_muscle_id || null, d.equipment_id || null, d.category_id || null,
        nullableText(d.movement_pattern) ?? null, nullableText(d.plane_of_motion) ?? null,
        nullableText(d.force) ?? null, nullableText(d.mechanic) ?? null,
        nullableText(d.instructions) ?? null,
        textArray(d.coaching_cues), textArray(d.common_mistakes),
        textArray(d.safety_tips), textArray(d.contraindications),
        nullableText(d.breathing_tips) ?? null, nullableText(d.tempo_recommendation) ?? null,
        nullableText(d.recommended_reps) ?? null, nullableText(d.recommended_sets) ?? null,
        nullableText(d.beginner_notes) ?? null, nullableText(d.advanced_notes) ?? null,
        nullableText(d.trainer_notes) ?? null,
        d.sets_default ? parseInt(d.sets_default, 10) : null,
        d.reps_default ? parseInt(d.reps_default, 10) : null,
        d.rest_seconds ? parseInt(d.rest_seconds, 10) : null,
        textArray(d.tags, 30),
        [name, d.search_keywords || '', d.equipment_name || ''].filter(Boolean).join(' ').trim(),
        orgId, req.user.id,
      ]
    );

    await writeMuscleLinks(client, id, d);
    await writeRelations(client, id, d);
    await client.query('COMMIT');

    const detail = await loadOne(id, req);
    res.status(201).json({ message: 'Exercise created', exercise: detail });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'An exercise with that name already exists' });
    next(err);
  } finally {
    client.release();
  }
});

// ─── UPDATE ───────────────────────────────────────────────────
//
// Every write here is version-captured by the exercises_version_history
// trigger, so an edit that breaks a cue list is always recoverable. Editing
// never touches ids, which is why a plan built last year still resolves.

router.put('/:id', auth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      'SELECT id, created_by, is_custom, organization_id FROM exercises WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Exercise not found' });
    if (!canEdit(req.user, existing[0])) return forbid(res);

    const d = req.body || {};
    if (d.difficulty && !DIFFICULTIES.has(d.difficulty))
      return res.status(400).json({ error: 'Invalid difficulty' });
    if (d.name !== undefined && !String(d.name).trim())
      return res.status(400).json({ error: 'Exercise name cannot be empty' });

    await client.query('BEGIN');

    // COALESCE-on-undefined: only fields the client actually sent are touched,
    // so a partial save from the detail drawer cannot blank the rest of the row.
    const sets = [];
    const params = [];
    const set = (col, val) => {
      if (val === undefined) return;
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    set('name',                 d.name !== undefined ? String(d.name).trim() : undefined);
    set('description',          nullableText(d.description));
    set('difficulty',           d.difficulty);
    set('primary_muscle_id',    d.primary_muscle_id);
    set('equipment_id',         d.equipment_id);
    set('category_id',          d.category_id);
    set('movement_pattern',     nullableText(d.movement_pattern));
    set('plane_of_motion',      nullableText(d.plane_of_motion));
    set('force',                nullableText(d.force));
    set('mechanic',             nullableText(d.mechanic));
    set('instructions',         nullableText(d.instructions));
    set('coaching_cues',        textArray(d.coaching_cues) ?? undefined);
    set('common_mistakes',      textArray(d.common_mistakes) ?? undefined);
    set('safety_tips',          textArray(d.safety_tips) ?? undefined);
    set('contraindications',    textArray(d.contraindications) ?? undefined);
    set('breathing_tips',       nullableText(d.breathing_tips));
    set('tempo_recommendation', nullableText(d.tempo_recommendation));
    set('recommended_reps',     nullableText(d.recommended_reps));
    set('recommended_sets',     nullableText(d.recommended_sets));
    set('beginner_notes',       nullableText(d.beginner_notes));
    set('advanced_notes',       nullableText(d.advanced_notes));
    set('trainer_notes',        nullableText(d.trainer_notes));
    set('tags',                 textArray(d.tags, 30) ?? undefined);
    set('search_keywords',      nullableText(d.search_keywords));
    set('sets_default',         d.sets_default !== undefined ? parseInt(d.sets_default, 10) || null : undefined);
    set('reps_default',         d.reps_default !== undefined ? parseInt(d.reps_default, 10) || null : undefined);
    set('rest_seconds',         d.rest_seconds !== undefined ? parseInt(d.rest_seconds, 10) || null : undefined);

    if (d.name !== undefined && d.regenerate_slug) {
      set('slug', slugify(d.name));
    }

    params.push(req.user.id);
    sets.push(`updated_by = $${params.length}`);

    if (sets.length) {
      params.push(req.params.id);
      await client.query(
        `UPDATE exercises SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }

    if (d.primary_muscle_id !== undefined || d.secondary_muscle_ids !== undefined) {
      await client.query('DELETE FROM exercise_muscles WHERE exercise_id = $1', [req.params.id]);
      await writeMuscleLinks(client, req.params.id, d);
    }
    if (d.progression_ids || d.regression_ids || d.alternative_ids) {
      await client.query('DELETE FROM exercise_relations WHERE exercise_id = $1', [req.params.id]);
      await writeRelations(client, req.params.id, d);
    }

    await client.query('COMMIT');
    const detail = await loadOne(req.params.id, req);
    res.json({ message: 'Exercise updated', exercise: detail });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'An exercise with that name already exists' });
    next(err);
  } finally {
    client.release();
  }
});

// ─── DUPLICATE ────────────────────────────────────────────────
// The fastest way to author a variation: copy "Barbell Squat", rename it
// "Paused Smith Squat", keep every cue. The copy is always custom and always
// belongs to the duplicating studio, even when the source is built-in.

router.post('/:id/duplicate', auth, async (req, res, next) => {
  if (!canCreate(req.user)) return forbid(res, 'You do not have permission to create exercises');

  const client = await pool.connect();
  try {
    const { rows: src } = await client.query(
      'SELECT * FROM exercises WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!src[0]) return res.status(404).json({ error: 'Exercise not found' });

    await client.query('BEGIN');
    const original = src[0];
    const newName = String(req.body?.name || `${original.name} (Copy)`).trim().slice(0, 120);

    let slug = slugify(newName);
    const { rows: taken } = await client.query(
      `SELECT slug FROM exercises WHERE slug LIKE $1 || '%' AND deleted_at IS NULL`, [slug]
    );
    if (taken.some((t) => t.slug === slug)) {
      let n = 2;
      while (taken.some((t) => t.slug === `${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }

    const id = randomUUID();
    await client.query(
      `INSERT INTO exercises (
         id, name, slug, description, muscle_group, difficulty,
         primary_muscle_id, equipment_id, category_id, movement_pattern, plane_of_motion,
         force, mechanic, instructions, coaching_cues, common_mistakes, safety_tips,
         contraindications, breathing_tips, tempo_recommendation,
         recommended_reps, recommended_sets, beginner_notes, advanced_notes, trainer_notes,
         sets_default, reps_default, rest_seconds, tags, search_keywords,
         visibility, is_custom, organization_id, created_by, updated_by
       )
       SELECT $1, $2, $3, description, muscle_group, difficulty,
              primary_muscle_id, equipment_id, category_id, movement_pattern, plane_of_motion,
              force, mechanic, instructions, coaching_cues, common_mistakes, safety_tips,
              contraindications, breathing_tips, tempo_recommendation,
              recommended_reps, recommended_sets, beginner_notes, advanced_notes, trainer_notes,
              sets_default, reps_default, rest_seconds, tags, $2,
              'organization', TRUE, $4, $5, $5
         FROM exercises WHERE id = $6`,
      [id, newName, slug, orgIdOf(req), req.user.id, req.params.id]
    );

    // Carry the muscle map across — a duplicate that loses its secondary
    // movers is not the same exercise.
    await client.query(
      `INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
       SELECT $1, muscle_id, role FROM exercise_muscles WHERE exercise_id = $2
       ON CONFLICT DO NOTHING`,
      [id, req.params.id]
    );

    await client.query('COMMIT');
    const detail = await loadOne(id, req);
    res.status(201).json({ message: 'Exercise duplicated', exercise: detail });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ─── ARCHIVE / RESTORE ────────────────────────────────────────
// Archiving hides an exercise from the picker without touching any programme
// that already uses it — the retirement path for a machine the gym sold.

router.post('/:id/archive', auth, async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, created_by, is_custom FROM exercises WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Exercise not found' });
    if (!canEdit(req.user, existing[0])) return forbid(res);

    const archive = req.body?.archived !== false;
    const { rows } = await pool.query(
      `UPDATE exercises SET archived_at = ${archive ? 'NOW()' : 'NULL'}, updated_by = $1
        WHERE id = $2 RETURNING id, archived_at`,
      [req.user.id, req.params.id]
    );
    res.json({ message: archive ? 'Exercise archived' : 'Exercise restored', exercise: rows[0] });
  } catch (err) { next(err); }
});

// ─── SOFT DELETE ──────────────────────────────────────────────
//
// Never a hard DELETE. workout_exercises now references exercises ON DELETE
// RESTRICT, so a hard delete of an in-use exercise would fail anyway — but the
// real reason is that a client's programme history should not change because
// someone tidied the library. `is_active` is kept in sync for the legacy
// /api/workouts/exercises reader.

router.delete('/:id', auth, async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, created_by, is_custom FROM exercises WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Exercise not found' });
    if (!canEdit(req.user, existing[0])) return forbid(res);

    const { rows: used } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM workout_exercises WHERE exercise_id = $1) AS in_plans,
              (SELECT COUNT(*)::int FROM workout_session_exercises WHERE exercise_id = $1) AS in_logs`,
      [req.params.id]
    );

    await pool.query(
      `UPDATE exercises SET deleted_at = NOW(), is_active = FALSE, updated_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]
    );

    res.json({
      message: 'Exercise deleted',
      still_referenced: used[0],
    });
  } catch (err) { next(err); }
});

// ─── FAVORITE TOGGLE ──────────────────────────────────────────

router.post('/:id/favorite', auth, async (req, res, next) => {
  try {
    const on = req.body?.favorite !== false;
    if (on) {
      await pool.query(
        `INSERT INTO exercise_favorites (user_id, exercise_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id]
      );
    } else {
      await pool.query(
        'DELETE FROM exercise_favorites WHERE user_id = $1 AND exercise_id = $2',
        [req.user.id, req.params.id]
      );
    }
    res.json({ message: on ? 'Added to favorites' : 'Removed from favorites', is_favorite: on });
  } catch (err) { next(err); }
});

// ─── RECORD USAGE ─────────────────────────────────────────────
// Called by the Workout Builder when an exercise is added to a programme.

router.post('/:id/use', auth, async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO exercise_recent_usage (user_id, exercise_id, use_count, used_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, exercise_id)
       DO UPDATE SET use_count = exercise_recent_usage.use_count + 1, used_at = NOW()`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── INTERNAL ─────────────────────────────────────────────────

async function writeMuscleLinks(client, exerciseId, d) {
  if (d.primary_muscle_id) {
    await client.query(
      `INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES ($1, $2, 'primary')
       ON CONFLICT (exercise_id, muscle_id) DO UPDATE SET role = 'primary'`,
      [exerciseId, d.primary_muscle_id]
    );
  }
  for (const mid of (Array.isArray(d.secondary_muscle_ids) ? d.secondary_muscle_ids : [])) {
    if (!mid || mid === d.primary_muscle_id) continue;
    await client.query(
      `INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES ($1, $2, 'secondary')
       ON CONFLICT (exercise_id, muscle_id) DO NOTHING`,
      [exerciseId, mid]
    );
  }
}

async function writeRelations(client, exerciseId, d) {
  const kinds = [
    ['progression', d.progression_ids],
    ['regression',  d.regression_ids],
    ['alternative', d.alternative_ids],
  ];
  for (const [type, ids] of kinds) {
    if (!Array.isArray(ids)) continue;
    let order = 0;
    for (const rid of ids) {
      if (!rid || rid === exerciseId) continue;
      await client.query(
        `INSERT INTO exercise_relations (exercise_id, related_exercise_id, relation_type, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [exerciseId, rid, type, order++]
      );
    }
  }
}

/** Re-reads a row through the same shape the detail endpoint returns. */
async function loadOne(id, req) {
  const params = [id];
  const vis = visibilityClause(req, params);
  const { rows } = await pool.query(
    `SELECT ${EXERCISE_COLUMNS} ${EXERCISE_JOINS}
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ${vis}`,
    params
  );
  if (!rows[0]) return null;
  const { rows: muscles } = await pool.query(
    `SELECT m.slug, m.name, m.body_region, em.role
       FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
      WHERE em.exercise_id = $1 ORDER BY em.role, m.sort_order`,
    [id]
  );
  rows[0].muscles = muscles;
  rows[0].can_edit = canEdit(req.user, rows[0]);
  return rows[0];
}

module.exports = router;
