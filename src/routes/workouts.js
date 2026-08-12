// src/routes/workouts.js — Exercise library + Workout Plans
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
// adminOrManager is gone from this file with the exercise write endpoints —
// exercise authoring is now trainer-accessible and lives in routes/exercises.js.
const { auth, adminManagerOrTrainer } = require('../middleware/auth');
const { checkScreeningGate } = require('../lib/screeningGate');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const { resolveWeek, previewWeeks } = require('../modules/pt-os/progression');

// ─── EXERCISES (COMPATIBILITY) ────────────────────────────────
//
// The Exercise Library now lives in routes/exercises.js and serves
// /api/exercises. These two readers stay because older clients still call
// them; they read the same table, so nothing has forked.
//
// The write endpoints that used to live here (POST/PUT/DELETE
// /api/workouts/exercises) are GONE, not deprecated. They wrote the flat
// legacy columns directly and knew nothing about slugs, the muscle join
// table, version history or ownership — a write through them would have
// produced a row the new library could not filter, search or attribute.
// Creation and editing go through /api/exercises, which is the only path
// that maintains all of it.
//
// Both readers below now exclude soft-deleted and archived rows, so an
// exercise retired in the new library disappears here too.

// GET /api/workouts/exercises  →  prefer GET /api/exercises
router.get('/exercises', auth, async (req, res, next) => {
  try {
    const { muscle_group, body_part, equipment, exercise_type, difficulty, search } = req.query;
    const conds = ['is_active = true', 'deleted_at IS NULL', 'archived_at IS NULL'];
    const params = [];
    let p = 1;

    if (muscle_group)   { conds.push(`muscle_group = $${p++}`);   params.push(muscle_group); }
    if (body_part)      { conds.push(`body_part = $${p++}`);       params.push(body_part); }
    if (equipment)      { conds.push(`equipment = $${p++}`);       params.push(equipment); }
    if (exercise_type)  { conds.push(`exercise_type = $${p++}`);   params.push(exercise_type); }
    if (difficulty)     { conds.push(`difficulty = $${p++}`);      params.push(difficulty); }
    if (search)         { conds.push(`name ILIKE $${p++}`);        params.push(`%${search}%`); }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, name, slug, muscle_group, body_part, target_muscle, secondary_muscles,
              equipment, difficulty, instructions, gif_url, exercise_type,
              force, mechanic, sets_default, reps_default, rest_seconds,
              video_url, image_url, is_active, source_id, created_at
       FROM exercises WHERE ${conds.join(' AND ')} ORDER BY body_part, name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/exercises/meta  →  prefer GET /api/exercises/meta
router.get('/exercises/meta', auth, async (req, res, next) => {
  try {
    const { body_part, equipment, exercise_type, difficulty, search } = req.query;
    const hasFilters = body_part || equipment || exercise_type || difficulty || search;
    const live = 'is_active = true AND deleted_at IS NULL AND archived_at IS NULL';

    const { rows: [meta] } = await pool.query(`
      SELECT
        array_agg(DISTINCT body_part    ORDER BY body_part)    FILTER (WHERE body_part IS NOT NULL)    AS body_parts,
        array_agg(DISTINCT equipment    ORDER BY equipment)    FILTER (WHERE equipment IS NOT NULL)    AS equipment_types,
        array_agg(DISTINCT exercise_type ORDER BY exercise_type) FILTER (WHERE exercise_type IS NOT NULL) AS exercise_types,
        array_agg(DISTINCT difficulty   ORDER BY difficulty)   FILTER (WHERE difficulty IS NOT NULL)   AS difficulties,
        COUNT(*)::int AS total
      FROM exercises WHERE ${live}
    `);

    if (!hasFilters) return res.json(meta);

    const conds = [live];
    const params = [];
    let p = 1;
    if (body_part)     { conds.push(`body_part = $${p++}`);     params.push(body_part); }
    if (equipment)     { conds.push(`equipment = $${p++}`);     params.push(equipment); }
    if (exercise_type) { conds.push(`exercise_type = $${p++}`); params.push(exercise_type); }
    if (difficulty)    { conds.push(`difficulty = $${p++}`);    params.push(difficulty); }
    if (search)        { conds.push(`name ILIKE $${p++}`);      params.push(`%${search}%`); }

    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM exercises WHERE ${conds.join(' AND ')}`,
      params
    );
    res.json({ ...meta, total: cnt.total });
  } catch (err) {
    next(err);
  }
});


// ─── WORKOUT PLANS ────────────────────────────────────────────
//
// ── Tenant scoping, and the one asymmetry in it ─────────────────────────────
//
// Until now none of the five plan endpoints filtered by organization, while the
// assignment endpoints in this same file did. Any authenticated user could
// read, edit or delete another studio's plan by guessing or leaking an id.
//
// Reads and writes are scoped differently, on purpose:
//
//   READ   organization_id = mine OR organization_id IS NULL
//   WRITE  organization_id = mine
//
// A NULL organization_id means a platform-authored template every studio can
// see — the meaning POST /plans already documents and the seeded rows carry.
// Studios must be able to READ those, or the shared library disappears. They
// must not be able to EDIT them, or one studio's change rewrites the template
// for everyone. Hence the asymmetry rather than one shared condition.

/**
 * SQL fragment restricting a SELECT to plans this caller may read.
 *
 * @param {object} req
 * @param {number} nextParam  1-based index of the next free $n placeholder
 * @returns {{ sql: string, params: any[] }} — sql is '' for a super admin
 */
function planReadFilter(req, nextParam) {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return { sql: '', params: [] };
  // Shared platform templates (organization_id IS NULL) stay visible.
  return {
    sql: `(wp.organization_id = $${nextParam} OR wp.organization_id IS NULL)`,
    params: [scope.orgId],
  };
}

/**
 * Load a plan the caller is allowed to MODIFY, or explain why not.
 *
 * Two independent checks, in the order that leaks least:
 *
 *   1. Tenant. The plan must belong to the caller's studio outright. A NULL
 *      organization_id is readable by everyone but writable by nobody except a
 *      super admin, so a studio cannot edit the shared library.
 *   2. Trainer ownership. A trainer may modify a plan they created, or one
 *      assigned to a client they train. Admin and manager skip this — they own
 *      the whole studio.
 *
 * Both failures return 404 rather than 403. A 403 on a plan in another studio
 * confirms that the id exists, which is exactly the fact the tenant boundary is
 * meant to hide.
 *
 * @returns {Promise<object|null>} the plan row, or null if not found/allowed
 */
async function loadEditablePlan(req, planId, client = pool) {
  const scope = tenantScope(req);
  const conds = ['wp.id = $1', 'wp.deleted_at IS NULL'];
  const params = [planId];

  if (scope.applyFilter) {
    conds.push(`wp.organization_id = $${params.length + 1}`);
    params.push(scope.orgId);
  }

  if (req.user?.role === 'trainer') {
    // Created it, or it is assigned to one of their clients. EXISTS rather
    // than a join so a plan assigned to several clients yields one row.
    conds.push(`(
      wp.created_by = $${params.length + 1}
      OR EXISTS (
        SELECT 1 FROM workout_assignments wa
          JOIN pt_clients pc ON pc.id = wa.client_id
         WHERE wa.workout_plan_id = wp.id
           AND pc.trainer_id = $${params.length + 2}
      )
    )`);
    params.push(req.user.id, req.user.trainer_id || '');
  }

  const { rows } = await client.query(
    `SELECT wp.* FROM workout_plans wp WHERE ${conds.join(' AND ')}`,
    params
  );
  return rows[0] || null;
}

/**
 * Numeric body field, preserving a legitimate zero.
 *
 * The previous handlers used `parseInt(x) || fallback`, which silently turned
 * `sets: 0` into 3 and `rest_seconds: 0` into 60 — so a trainer could not
 * prescribe a superset with no rest, and the value they saved was not the value
 * they typed.
 */
function num(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** The six columns migration 136 added, read from a request body. */
function exerciseParams(ex) {
  return [
    num(ex.target_weight), ex.tempo ?? null, num(ex.rpe), num(ex.warmup_sets),
    ex.superset_group ?? null, ex.config ? JSON.stringify(ex.config) : null,
  ];
}

/** Columns selected for a planned exercise, everywhere. One list, one source. */
const EXERCISE_SELECT = `
  we.id, we.exercise_id, e.name, e.muscle_group, e.video_url, e.gif_url,
  we.day_of_week, we.week_number, we.sort_order, we.sets, we.reps, we.rest_seconds, we.notes,
  we.target_weight, we.tempo, we.rpe, we.warmup_sets, we.superset_group, we.config`;

// GET /api/workouts/plans
router.get('/plans', auth, async (req, res, next) => {
  try {
    const { goal, client_id } = req.query;
    const conds = ['wp.deleted_at IS NULL AND wp.is_active = true'];
    const params = [];
    let p = 1;

    if (goal)      { conds.push(`wp.goal = $${p++}`);           params.push(goal); }
    if (client_id) { conds.push(`wa.client_id = $${p++}`);      params.push(client_id); }

    const joinClause = client_id
      ? `LEFT JOIN workout_assignments wa ON wa.workout_plan_id = wp.id AND wa.client_id = $${p-1}`
      : '';

    const tenant = planReadFilter(req, p);
    if (tenant.sql) { conds.push(tenant.sql); params.push(...tenant.params); p += tenant.params.length; }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT wp.*,
        COALESCE((SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_plan_id = wp.id), 0)::int AS exercise_count,
        ${client_id ? `(SELECT wa2.progress_pct FROM workout_assignments wa2 WHERE wa2.workout_plan_id = wp.id AND wa2.client_id = $1 AND wa2.status = 'active' LIMIT 1)::int AS progress,` : '0 AS progress,'}
        COALESCE((SELECT json_agg(json_build_object(
          'id', we.id, 'exercise_id', we.exercise_id, 'name', e.name,
          'muscle_group', e.muscle_group, 'sets', we.sets, 'reps', we.reps,
          'rest_seconds', we.rest_seconds,
          'day_of_week', we.day_of_week, 'sort_order', we.sort_order, 'notes', we.notes,
          'target_weight', we.target_weight, 'tempo', we.tempo, 'rpe', we.rpe,
          'warmup_sets', we.warmup_sets, 'superset_group', we.superset_group, 'config', we.config
        ) ORDER BY we.day_of_week, we.sort_order)
        FROM workout_exercises we
        LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = wp.id), '[]'::json) AS exercises
      FROM workout_plans wp
      ${joinClause}
      WHERE ${conds.join(' AND ')}
      ORDER BY wp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/plans/:id — full detail, exercises ordered by day then slot.
router.get('/plans/:id', auth, async (req, res, next) => {
  try {
    const tenant = planReadFilter(req, 2);
    const { rows: planRows } = await pool.query(
      `SELECT wp.* FROM workout_plans wp
        WHERE wp.id = $1 AND wp.deleted_at IS NULL
        ${tenant.sql ? `AND ${tenant.sql}` : ''}`,
      [req.params.id, ...tenant.params]
    );
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    const { rows: exercises } = await pool.query(
      `SELECT ${EXERCISE_SELECT}
         FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = $1
        ORDER BY we.day_of_week, we.sort_order`,
      [req.params.id]
    );
    // ?week=N returns the prescription for that week rather than the stored
    // week-1 rows — the same resolution the client's log uses, so the builder
    // and the gym floor cannot disagree about what week 6 says.
    const requestedWeek = parseInt(req.query.week, 10);
    if (Number.isFinite(requestedWeek) && requestedWeek > 1) {
      const byDay = new Map();
      for (const ex of exercises) {
        if (!byDay.has(ex.day_of_week)) byDay.set(ex.day_of_week, []);
        byDay.get(ex.day_of_week).push(ex);
      }
      const resolved = [];
      let source = 'derived';
      for (const rows of byDay.values()) {
        const r = resolveWeek(rows, plan, requestedWeek);
        if (r.source === 'override') source = 'override';
        resolved.push(...r.exercises);
      }
      return res.json({ ...plan, week: requestedWeek, week_source: source, exercises: resolved });
    }

    // Where the rule lands, per exercise, without an extra round trip and
    // without reimplementing the arithmetic in TypeScript where it could drift
    // from the server's. A rule is abstract until you see that +2.5kg/week
    // turns 60 into 87.5 by week 12 — which a trainer may well decide is too
    // much, and that is cheaper to learn here than in week 9.
    const preview = plan.progression_type === 'none' ? null : exercises.map((ex) => {
      const weeks = previewWeeks(ex, plan, plan.duration_weeks);
      return { id: ex.id, first: weeks[0], last: weeks[weeks.length - 1] };
    });

    res.json({ ...plan, week: 1, week_source: 'base', exercises, progression_preview: preview });
  } catch (err) {
    next(err);
  }
});

// POST /api/workouts/plans
router.post('/plans', auth, adminManagerOrTrainer, async (req, res, next) => {
  const d = req.body;
  if (!d.name?.trim())
    return res.status(400).json({ error: 'Plan name required' });

  try {
    const id = randomUUID();
    const { rows } = await pool.query(`
      INSERT INTO workout_plans (id, name, description, goal, difficulty,
        duration_weeks, sessions_per_week, is_template, created_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, d.name.trim(), d.description || null, d.goal || 'general_fitness',
       d.difficulty || 'beginner', parseInt(d.duration_weeks) || 4,
       parseInt(d.sessions_per_week) || 3, d.is_template !== false, req.user.id,
       // Stamps the owning studio (migration 106). NULL only for a platform
       // operator authoring a template that every studio should see — the same
       // meaning the seeded rows carry.
       orgIdOf(req)]
    );

    // Add exercises if provided
    if (Array.isArray(d.exercises)) {
      for (const ex of d.exercises) {
        await pool.query(`
          INSERT INTO workout_exercises (id, workout_plan_id, exercise_id, day_of_week,
            sort_order, sets, reps, rest_seconds, notes,
            target_weight, tempo, rpe, warmup_sets, superset_group, config)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [randomUUID(), id, ex.exercise_id, num(ex.day_of_week, 1),
           num(ex.sort_order, 0), num(ex.sets, 3), num(ex.reps, 12),
           num(ex.rest_seconds, 60), ex.notes || null, ...exerciseParams(ex)]
        );
      }
    }

    res.status(201).json({ message: 'Workout plan created', plan: rows[0] });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Tables not ready. Run migrations.' });
    next(err);
  }
});

// PUT /api/workouts/plans/:id
//
// Whole-plan replace. Kept exactly as it was for the clients that already use
// it, but note what it does: if `exercises` is present it deletes EVERY row for
// the plan and re-inserts, minting new ids. That is why the builder does not
// autosave through here — a save of one day would delete the other six, and
// every save would invalidate the ids the UI is dragging. Use the granular
// endpoints below for incremental edits.
router.put('/plans/:id', auth, adminManagerOrTrainer, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const d = req.body;
    await client.query('BEGIN');

    const existing = await loadEditablePlan(req, req.params.id, client);
    if (!existing) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Workout plan not found' }); }

    const { rows } = await client.query(`
      UPDATE workout_plans SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        goal = COALESCE($3, goal),
        difficulty = COALESCE($4, difficulty),
        duration_weeks = COALESCE($5, duration_weeks),
        sessions_per_week = COALESCE($6, sessions_per_week),
        progression_type = COALESCE($8, progression_type),
        -- Not COALESCE: clearing the amount is a real edit, and the pair moves
        -- together. When a type is sent, the amount sent with it wins —
        -- including null, which the CHECK then rejects unless the type is
        -- 'none'. That is the point: a rule with no amount cannot be stored.
        progression_amount = CASE WHEN $8::text IS NULL THEN progression_amount ELSE $9 END,
        progression_every_weeks = COALESCE($10, progression_every_weeks),
        updated_at = NOW()
      WHERE id = $7 RETURNING *`,
      [d.name || null, d.description ?? null, d.goal || null, d.difficulty || null,
       d.duration_weeks ? parseInt(d.duration_weeks) : null,
       d.sessions_per_week ? parseInt(d.sessions_per_week) : null, req.params.id,
       d.progression_type || null,
       d.progression_amount === undefined || d.progression_amount === null || d.progression_amount === ''
         ? null : Number(d.progression_amount),
       d.progression_every_weeks ? parseInt(d.progression_every_weeks) : null]
    );

    if (Array.isArray(d.exercises)) {
      await client.query('DELETE FROM workout_exercises WHERE workout_plan_id = $1', [req.params.id]);
      for (const ex of d.exercises) {
        await client.query(`
          INSERT INTO workout_exercises (id, workout_plan_id, exercise_id, day_of_week,
            sort_order, sets, reps, rest_seconds, notes,
            target_weight, tempo, rpe, warmup_sets, superset_group, config)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [randomUUID(), req.params.id, ex.exercise_id, num(ex.day_of_week, 1),
           num(ex.sort_order, 0), num(ex.sets, 3), num(ex.reps, 12),
           num(ex.rest_seconds, 60), ex.notes || null, ...exerciseParams(ex)]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Plan updated', plan: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── VERSION SNAPSHOTS ────────────────────────────────────────
//
// What is at risk here is the PRESCRIPTION, not the history. What a client
// actually did is in workout_sessions and workout_sets, recorded independently
// and unaffected by any edit. What an edit destroys is what the plan SAID —
// the March programme, once April's numbers are typed over it.
//
// So a snapshot ARCHIVES the current state and leaves the live plan alone:
// same id, same assignments, same clients. The alternative — minting a new
// plan and repointing assignments — would move every client on a shared
// template at once, which is not what "keep a copy of what I had" means.
//
// Not automatic. The builder autosaves on every field blur, so versioning on
// write would mint a snapshot per keystroke. This is the deliberate action.

// POST /api/workouts/plans/:id/versions — freeze the current state as history.
router.post('/plans/:id/versions', auth, adminManagerOrTrainer, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await loadEditablePlan(req, req.params.id, client);
    if (!plan) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Workout plan not found' }); }
    // Snapshotting a snapshot would build a chain nothing can render and
    // nothing asked for. A snapshot's parent is always the live plan.
    if (plan.parent_plan_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This is already an archived version' });
    }

    const snapshotId = randomUUID();
    // is_active = false and is_template = false keep it out of every list: an
    // archived version is history to read, never a plan to assign.
    await client.query(
      `INSERT INTO workout_plans (
         id, name, description, goal, difficulty, duration_weeks, sessions_per_week,
         is_template, is_active, created_by, organization_id,
         progression_type, progression_amount, progression_every_weeks,
         version, parent_plan_id)
       SELECT $1, name, description, goal, difficulty, duration_weeks, sessions_per_week,
              false, false, $2, organization_id,
              progression_type, progression_amount, progression_every_weeks,
              version, id
         FROM workout_plans WHERE id = $3`,
      [snapshotId, req.user.id, req.params.id]
    );

    // INSERT ... SELECT rather than a read-then-loop: the copy is one
    // statement inside the same transaction, so a concurrent edit cannot land
    // between reading an exercise and writing it.
    const { rowCount } = await client.query(
      `INSERT INTO workout_exercises (
         id, workout_plan_id, exercise_id, day_of_week, week_number, sort_order,
         sets, reps, rest_seconds, notes,
         target_weight, tempo, rpe, warmup_sets, superset_group, config)
       SELECT gen_random_uuid()::text, $1, exercise_id, day_of_week, week_number, sort_order,
              sets, reps, rest_seconds, notes,
              target_weight, tempo, rpe, warmup_sets, superset_group, config
         FROM workout_exercises WHERE workout_plan_id = $2`,
      [snapshotId, req.params.id]
    );

    // The LIVE plan moves forward. The snapshot keeps the number it was.
    const { rows } = await client.query(
      'UPDATE workout_plans SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: `Saved version ${plan.version}`,
      plan: rows[0],
      snapshot: { id: snapshotId, version: plan.version, exercise_count: rowCount },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/workouts/plans/:id/versions — the archived states, newest first.
router.get('/plans/:id/versions', auth, async (req, res, next) => {
  try {
    // Scoped through the PARENT, so a caller who cannot read the plan cannot
    // read its history either — the snapshots carry the same organization_id,
    // but checking the parent means one rule to keep right instead of two.
    const tenant = planReadFilter(req, 2);
    const { rows: parent } = await pool.query(
      `SELECT wp.id FROM workout_plans wp
        WHERE wp.id = $1 AND wp.deleted_at IS NULL
        ${tenant.sql ? `AND ${tenant.sql}` : ''}`,
      [req.params.id, ...tenant.params]
    );
    if (!parent[0]) return res.status(404).json({ error: 'Workout plan not found' });

    const { rows } = await pool.query(
      `SELECT wp.id, wp.version, wp.created_at, wp.progression_type,
              wp.progression_amount, wp.progression_every_weeks, wp.duration_weeks,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_plan_id = wp.id)::int AS exercise_count
         FROM workout_plans wp
         LEFT JOIN users u ON u.id = wp.created_by
        WHERE wp.parent_plan_id = $1 AND wp.deleted_at IS NULL
        ORDER BY wp.version DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── PLANNED EXERCISES: granular, id-stable edits ─────────────
//
// These exist so the builder can autosave. Each one touches exactly the rows it
// names, so editing Monday cannot disturb Tuesday, and an exercise keeps its id
// for its whole life — which is what makes drag-reorder and per-card state
// possible at all.

// POST /api/workouts/plans/:id/exercises — append one exercise to a day
router.post('/plans/:id/exercises', auth, adminManagerOrTrainer, async (req, res, next) => {
  try {
    const plan = await loadEditablePlan(req, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    const ex = req.body;
    if (!ex.exercise_id) return res.status(400).json({ error: 'exercise_id required' });
    const day = num(ex.day_of_week, 1);

    // Append: one past the current last slot for that day. Computed in SQL so
    // two trainers adding at once cannot both claim the same sort_order.
    const { rows } = await pool.query(`
      INSERT INTO workout_exercises (id, workout_plan_id, exercise_id, day_of_week,
        sort_order, sets, reps, rest_seconds, notes,
        target_weight, tempo, rpe, warmup_sets, superset_group, config)
      VALUES ($1,$2,$3,$4,
        COALESCE((SELECT MAX(sort_order) + 1 FROM workout_exercises
                   WHERE workout_plan_id = $2 AND day_of_week = $4), 0),
        $5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id`,
      [randomUUID(), req.params.id, ex.exercise_id, day,
       num(ex.sets, 3), num(ex.reps, 12), num(ex.rest_seconds, 60), ex.notes || null,
       ...exerciseParams(ex)]
    );

    // Re-read through the same projection every other endpoint uses, so the
    // card the UI renders from this response is identical to the one it would
    // get from a reload.
    const { rows: full } = await pool.query(
      `SELECT ${EXERCISE_SELECT} FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id WHERE we.id = $1`,
      [rows[0].id]
    );
    res.status(201).json({ message: 'Exercise added', exercise: full[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/workouts/plans/:id/exercises/:rowId — edit fields in place
router.patch('/plans/:id/exercises/:rowId', auth, adminManagerOrTrainer, async (req, res, next) => {
  try {
    const plan = await loadEditablePlan(req, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    // Whitelist. A blind loop over req.body would let a caller rewrite id,
    // workout_plan_id or created_at — the same reason the billing settings
    // endpoint enumerates its fields.
    const EDITABLE = {
      exercise_id: (v) => v,
      day_of_week: (v) => num(v),
      sort_order: (v) => num(v),
      sets: (v) => num(v),
      reps: (v) => num(v),
      rest_seconds: (v) => num(v),
      notes: (v) => v ?? null,
      target_weight: (v) => num(v),
      tempo: (v) => v ?? null,
      rpe: (v) => num(v),
      warmup_sets: (v) => num(v),
      superset_group: (v) => v ?? null,
      config: (v) => (v == null ? null : JSON.stringify(v)),
    };

    const sets = [];
    const params = [req.params.rowId, req.params.id];
    for (const [key, coerce] of Object.entries(EDITABLE)) {
      // `in` rather than a truthiness test: clearing a field to null and
      // setting a number to 0 are both legitimate edits.
      if (key in req.body) {
        sets.push(`${key} = $${params.length + 1}`);
        params.push(coerce(req.body[key]));
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });

    const { rows } = await pool.query(
      `UPDATE workout_exercises SET ${sets.join(', ')}
        WHERE id = $1 AND workout_plan_id = $2 RETURNING id`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Exercise not found in this plan' });

    const { rows: full } = await pool.query(
      `SELECT ${EXERCISE_SELECT} FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id WHERE we.id = $1`,
      [req.params.rowId]
    );
    res.json({ message: 'Exercise updated', exercise: full[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workouts/plans/:id/exercises/:rowId
router.delete('/plans/:id/exercises/:rowId', auth, adminManagerOrTrainer, async (req, res, next) => {
  try {
    const plan = await loadEditablePlan(req, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    // A hard delete: a planned exercise is an editing artefact, not a record of
    // anything that happened. What the client actually performed lives in
    // workout_sessions and is untouched by this.
    const { rows } = await pool.query(
      'DELETE FROM workout_exercises WHERE id = $1 AND workout_plan_id = $2 RETURNING id',
      [req.params.rowId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Exercise not found in this plan' });
    res.json({ message: 'Exercise removed' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/workouts/plans/:id/days/:day/order — reorder one day, ids preserved
router.put('/plans/:id/days/:day/order', auth, adminManagerOrTrainer, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const plan = await loadEditablePlan(req, req.params.id, client);
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    const ids = req.body?.exercise_ids;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'exercise_ids array required' });
    }

    const day = num(req.params.day);
    if (day === null) return res.status(400).json({ error: 'Invalid day' });

    await client.query('BEGIN');

    // Every id must already belong to this plan and this day. Without the
    // check, a caller could pass an id from another day — or another plan —
    // and the UPDATE would silently move it here.
    const { rows: owned } = await client.query(
      `SELECT id FROM workout_exercises
        WHERE workout_plan_id = $1 AND day_of_week = $2`,
      [req.params.id, day]
    );
    const ownedIds = new Set(owned.map((r) => r.id));
    if (ids.length !== ownedIds.size || ids.some((id) => !ownedIds.has(id))) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'exercise_ids must list exactly the exercises already on this day',
      });
    }

    // Single statement rather than a loop: the whole reorder lands at once, so
    // there is no window in which two rows share a sort_order.
    await client.query(
      `UPDATE workout_exercises AS we
          SET sort_order = v.ord
         FROM (SELECT unnest($1::text[]) AS id,
                      generate_series(0, array_length($1::text[], 1) - 1) AS ord) AS v
        WHERE we.id = v.id AND we.workout_plan_id = $2`,
      [ids, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Order updated', count: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/workouts/plans/:id
router.delete('/plans/:id', auth, adminManagerOrTrainer, async (req, res, next) => {
  try {
    const plan = await loadEditablePlan(req, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Workout plan not found' });

    const { rows } = await pool.query(
      'UPDATE workout_plans SET deleted_at=NOW(), is_active=false WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Workout plan not found' });
    res.json({ message: 'Workout plan deleted' });
  } catch (err) {
    next(err);
  }
});
// ─── WORKOUT ASSIGNMENTS ──────────────────────────────────────

// GET /api/workouts/assignments?client_id=&status=
router.get('/assignments', auth, async (req, res, next) => {
  try {
    const { client_id, status } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    const conds = ['wa.client_id = $1'];
    const params = [client_id];
    let p = 2;
    if (status) { conds.push(`wa.status = $${p++}`); params.push(status); }
    const scope = tenantScope(req);
    if (scope.applyFilter) { conds.push(`wa.organization_id = $${p++}`); params.push(scope.orgId); }

    const { rows } = await pool.query(`
      SELECT wa.*, wp.name AS plan_name, wp.goal AS plan_goal,
             wp.duration_weeks, wp.sessions_per_week
        FROM workout_assignments wa
        JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE ${conds.join(' AND ')}
       ORDER BY wa.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// GET /api/workouts/assignments/:id — single assignment + its plan's full
// prescribed exercises (feeds "today's prescribed exercises" in the log).
router.get('/assignments/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND wa.organization_id = $2' : '';
    const { rows: assignRows } = await pool.query(`
      SELECT wa.*, wp.name AS plan_name, wp.goal AS plan_goal,
             wp.duration_weeks, wp.sessions_per_week
        FROM workout_assignments wa
        JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE wa.id = $1${guard}`,
      scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
    );
    const assignment = assignRows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const { rows: exercises } = await pool.query(
      `SELECT we.id, we.exercise_id, e.name, e.muscle_group, we.sets, we.reps,
              we.rest_seconds, we.day_of_week, we.sort_order, we.notes
         FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = $1
        ORDER BY we.day_of_week, we.sort_order`,
      [assignment.workout_plan_id]
    );
    res.json({ ...assignment, exercises });
  } catch (err) {
    next(err);
  }
});

// POST /api/workouts/assign
router.post('/assign', auth, adminManagerOrTrainer, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.workout_plan_id || !d.client_id)
      return res.status(400).json({ error: 'workout_plan_id and client_id required' });

    // Assigning is part of a trainer's job, so this is no longer admin-only.
    // Two things have to hold, and neither was checked before:
    //
    //   1. The plan must be one this caller can see — including a shared
    //      platform template, which is legitimate to assign even though it
    //      cannot be edited. planReadFilter, not loadEditablePlan, for exactly
    //      that reason.
    //   2. A trainer may only assign to their own client. Without this a
    //      trainer could attach a programme to any client in the studio.
    const tenant = planReadFilter(req, 2);
    const { rows: planRows } = await pool.query(
      `SELECT wp.id FROM workout_plans wp
        WHERE wp.id = $1 AND wp.deleted_at IS NULL
        ${tenant.sql ? `AND ${tenant.sql}` : ''}`,
      [d.workout_plan_id, ...tenant.params]
    );
    if (!planRows[0]) return res.status(404).json({ error: 'Workout plan not found' });

    if (req.user.role === 'trainer') {
      const { rows: mine } = await pool.query(
        'SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2',
        [d.client_id, req.user.trainer_id || '']
      );
      // 404, not 403: a 403 would confirm the client exists.
      if (!mine[0]) return res.status(404).json({ error: 'Client not found' });
    }

    // PAR-Q + Informed Consent gate — shared with Workout Log session
    // creation (src/lib/screeningGate.js) so both entry points enforce the
    // exact same clearance rule: explicit medical blocks stop the action,
    // missing paperwork proceeds with warnings for the UI to surface.
    const { blocked, warnings } = await checkScreeningGate(req, d.client_id);
    if (blocked) return res.status(blocked.status).json(blocked.body);

    const { rows } = await pool.query(`
      INSERT INTO workout_assignments (id, workout_plan_id, client_id, trainer_id,
        start_date, end_date, status, notes, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (workout_plan_id, client_id, status)
      DO UPDATE SET status = 'active', start_date = EXCLUDED.start_date,
        organization_id = COALESCE(workout_assignments.organization_id, EXCLUDED.organization_id), updated_at = NOW()
      RETURNING *`,
      [randomUUID(), d.workout_plan_id, d.client_id, req.user.trainer_id || null,
       d.start_date || new Date().toISOString().split('T')[0],
       d.end_date || null, 'active', d.notes || null, orgIdOf(req)]
    );
    res.status(201).json({ message: 'Plan assigned', assignment: rows[0], screening_warnings: warnings });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.status(400).json({ error: 'Tables not ready. Run migrations.' });
    next(err);
  }
});

// PUT /api/workouts/assignments/:id/progress
router.put('/assignments/:id/progress', auth, async (req, res, next) => {
  try {
    const pct = parseInt(req.body.progress_pct);
    if (isNaN(pct) || pct < 0 || pct > 100)
      return res.status(400).json({ error: 'progress_pct must be 0-100' });

    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $3' : '';
    const { rows } = await pool.query(`
      UPDATE workout_assignments SET progress_pct=$1, updated_at=NOW()
      WHERE id=$2${guard} RETURNING *`,
      scope.applyFilter ? [pct, req.params.id, scope.orgId] : [pct, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ message: 'Progress updated', assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
