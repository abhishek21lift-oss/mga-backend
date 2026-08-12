// src/modules/pt-os/workout-log.routes.js
// Workout Log — logging what a client actually performed in a session
// (as opposed to workout_plans/workout_exercises, which are prescribed
// templates, or workout_assignments, which just tracks which plan a
// client is on). See migration 068 for the schema rationale.
//
// Mounted at /api/pt-os, so final paths are /api/pt-os/workout-log/...
// Conventions follow informed-consent.routes.js / parq.routes.js: a
// shared wrap() for async error handling, auth + requireRole on writes
// (staff-operated app, no separate client login), logActivity for the
// audit trail, and server-computed derived fields never trusted from
// the client (here: PR flags and workout summary totals).
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { calc1RM } = require('../progress/fitness-scoring');
const { checkScreeningGate } = require('../../lib/screeningGate');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');
const { today: studioToday } = require('../../lib/appTime');
const { weekOf, resolveWeek } = require('./progression');
const { adherence, muscleWeek, prTimeline, missedDays, weekStart } = require('./training-analytics');
const { generateWeeklyProgressPdf } = require('../../lib/weeklyProgressPdf');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const numOpt = () => z.coerce.number().optional().nullable();

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Recomputes a linked assignment's progress_pct from how many distinct
// completed sessions have been logged against it, relative to the plan's
// target (sessions_per_week * duration_weeks). The only writer of
// progress_pct outside the trainer's manual PUT /assignments/:id/progress.
async function recomputeAssignmentProgress(assignmentId) {
  if (!assignmentId) return;
  const { rows } = await pool.query(
    `SELECT wp.sessions_per_week, wp.duration_weeks,
            (SELECT COUNT(DISTINCT ws.id) FROM workout_sessions ws
              WHERE ws.workout_assignment_id = wa.id AND ws.status = 'completed') AS completed_count
       FROM workout_assignments wa
       JOIN workout_plans wp ON wp.id = wa.workout_plan_id
      WHERE wa.id = $1`,
    [assignmentId]
  );
  const row = rows[0];
  if (!row) return;
  const target = (row.sessions_per_week || 0) * (row.duration_weeks || 0);
  const pct = target > 0 ? Math.min(100, Math.round((row.completed_count / target) * 100)) : 0;
  await pool.query('UPDATE workout_assignments SET progress_pct = $1, updated_at = NOW() WHERE id = $2', [pct, assignmentId]);
}

// ─── Schemas ────────────────────────────────────────────────

const sessionCreateSchema = {
  body: z.object({
    client_id: z.string(),
    session_date: z.string().optional().nullable(),
    program_name: z.string().max(255).optional().nullable(),
    workout_day: z.string().max(255).optional().nullable(),
    workout_assignment_id: z.string().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
};

const sessionUpdateSchema = {
  body: z.object({
    session_date: z.string().optional(),
    program_name: z.string().max(255).optional().nullable(),
    workout_day: z.string().max(255).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    duration_minutes: numOpt(),
    status: z.enum(['in_progress', 'completed']).optional(),
  }),
};

const exerciseAddSchema = {
  body: z.object({
    exercise_id: z.string().optional().nullable(),
    exercise_name: z.string().min(1).max(255),
    notes: z.string().max(1000).optional().nullable(),
  }),
};

const setCreateSchema = {
  body: z.object({
    set_number: z.coerce.number().int().min(1),
    weight_kg: numOpt(),
    reps: z.coerce.number().int().optional().nullable(),
    rpe: numOpt(),
    rir: z.coerce.number().int().optional().nullable(),
    tempo: z.string().max(20).optional().nullable(),
    rest_seconds: z.coerce.number().int().optional().nullable(),
    completed: z.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
};

const setUpdateSchema = {
  body: z.object({
    weight_kg: numOpt(),
    reps: z.coerce.number().int().optional().nullable(),
    rpe: numOpt(),
    rir: z.coerce.number().int().optional().nullable(),
    tempo: z.string().max(20).optional().nullable(),
    rest_seconds: z.coerce.number().int().optional().nullable(),
    completed: z.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  }),
};

// ─── Helpers ────────────────────────────────────────────────

// Never trust a client-submitted "is this a PR" flag — always recompute
// against the client's prior completed sets for the same exercise
// (matched by exercise_id when the exercise is in the library, else by
// exact exercise_name for ad-hoc entries).
async function computePrFlags(client, clientId, exerciseId, exerciseName, weight, reps, excludeSetId) {
  if (weight == null || reps == null) return { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };

  const matchClause = exerciseId ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exerciseId || exerciseName;
  const params = [clientId, matchParam];
  let excludeClause = '';
  if (excludeSetId) { params.push(excludeSetId); excludeClause = `AND s.id != $${params.length}`; }

  const { rows } = await client.query(
    `SELECT MAX(s.weight_kg) AS max_weight, MAX(s.reps) AS max_reps, MAX(s.weight_kg * s.reps) AS max_volume
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} AND s.completed = true ${excludeClause}`,
    params
  );
  const prev = rows[0] || {};
  const volume = weight * reps;
  return {
    is_pr_weight: prev.max_weight == null || weight > Number(prev.max_weight),
    is_pr_reps: prev.max_reps == null || reps > Number(prev.max_reps),
    is_pr_volume: prev.max_volume == null || volume > Number(prev.max_volume),
  };
}

// ─── Sessions ───────────────────────────────────────────────

// GET /workout-log/sessions?client_id=&limit=&offset=
router.get('/workout-log/sessions', auth, wrap(async (req, res) => {
  const { client_id, limit, offset } = req.query;
  if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  const scope = tenantScope(req);
  const params = [client_id];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = ` AND ws.organization_id = $${params.length}`; }
  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT ws.*,
            (SELECT COUNT(*) FROM workout_session_exercises wse WHERE wse.session_id = ws.id) AS exercise_count,
            (SELECT COUNT(*) FROM workout_sets s
               JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
              WHERE wse.session_id = ws.id AND s.completed = true) AS completed_set_count
       FROM workout_sessions ws
      WHERE ws.client_id = $1${orgClause}
      ORDER BY ws.session_date DESC, ws.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ data: rows });
}));

// GET /workout-log/sessions/:id — full detail with exercises + sets + computed summary.
router.get('/workout-log/sessions/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const sessGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const sessParams = scope.applyFilter ? [id, scope.orgId] : [id];
  const [sessionRes, exercisesRes] = await Promise.all([
    pool.query(`SELECT * FROM workout_sessions WHERE id = $1${sessGuard}`, sessParams),
    pool.query(
      `SELECT wse.*, COALESCE(
                (SELECT json_agg(s.* ORDER BY s.set_number)
                   FROM workout_sets s WHERE s.session_exercise_id = wse.id),
                '[]'
              ) AS sets
         FROM workout_session_exercises wse
        WHERE wse.session_id = $1
        ORDER BY wse.sort_order, wse.created_at`,
      [id]
    ),
  ]);
  const session = sessionRes.rows[0];
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  const exercises = exercisesRes.rows;

  // "Planned for today": when this session is linked to an active plan
  // assignment, show what the plan prescribes for the matching day-of-week
  // so the trainer can compare/load it in without re-typing the program.
  let planned = null;
  if (session.workout_assignment_id) {
    const dayIndex = session.workout_day ? WEEKDAYS.indexOf(session.workout_day) : -1;
    const { rows: planRows } = await pool.query(
      `SELECT wp.id AS plan_id, wp.name AS plan_name, wp.duration_weeks,
              wp.progression_type, wp.progression_amount, wp.progression_every_weeks,
              wa.start_date
         FROM workout_assignments wa
         JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        WHERE wa.id = $1`,
      [session.workout_assignment_id]
    );
    const plan = planRows[0];
    if (plan && dayIndex >= 0) {
      // Every week's rows for this weekday, not just week 1: resolveWeek needs
      // the overrides as well as the base to decide which wins.
      const { rows: allWeeks } = await pool.query(
        `SELECT we.exercise_id, e.name, we.week_number, we.sets, we.reps, we.rest_seconds,
                we.sort_order, we.notes, we.target_weight, we.tempo, we.rpe,
                we.warmup_sets, we.superset_group, we.config
           FROM workout_exercises we
           LEFT JOIN exercises e ON e.id = we.exercise_id
          WHERE we.workout_plan_id = $1 AND we.day_of_week = $2
          ORDER BY we.sort_order`,
        [plan.plan_id, dayIndex + 1]
      );
      // Which week the client is actually in, from the assignment's start date
      // and the date of THIS session — not today. Back-filling last Tuesday's
      // workout must show last Tuesday's week, or the trainer is handed the
      // wrong prescription for a session that already happened.
      const week = weekOf(plan.start_date, session.session_date);
      const resolved = resolveWeek(allWeeks, plan, week);
      planned = {
        plan_name: plan.plan_name,
        week,
        duration_weeks: plan.duration_weeks,
        progression_type: plan.progression_type,
        // 'derived' means these numbers came from week 1 plus the rule;
        // 'override' means the trainer wrote this week by hand. The UI says
        // which, because a derived number is a suggestion and a written one
        // is an instruction.
        source: resolved.source,
        exercises: resolved.exercises,
      };
    }
  }

  let totalSets = 0, totalReps = 0, totalVolume = 0, rpeSum = 0, rpeCount = 0;
  // plannedSets counts every set the trainer laid out, completed or not — it
  // is the denominator for completion. prs counts SETS that beat a previous
  // best, not exercises: three PRs on one lift is three PRs.
  let plannedSets = 0, prs = 0;
  for (const ex of exercises) {
    for (const s of ex.sets) {
      plannedSets += 1;
      if (s.is_pr_weight || s.is_pr_reps || s.is_pr_volume) prs += 1;
      if (!s.completed) continue;
      totalSets += 1;
      if (s.reps) totalReps += s.reps;
      if (s.weight_kg != null && s.reps) totalVolume += Number(s.weight_kg) * s.reps;
      if (s.rpe != null) { rpeSum += Number(s.rpe); rpeCount += 1; }
    }
  }

  res.json({
    data: {
      ...session,
      exercises,
      planned,
      summary: {
        total_sets: totalSets,
        total_reps: totalReps,
        total_volume: Math.round(totalVolume * 100) / 100,
        exercises_completed: exercises.filter((ex) => ex.sets.some((s) => s.completed)).length,
        exercises_total: exercises.length,
        avg_rpe: rpeCount ? Math.round((rpeSum / rpeCount) * 10) / 10 : null,
        planned_sets: plannedSets,
        // null, not 0, when nothing was laid out: "no plan" and "none of the
        // plan done" are different things and the UI must not show 0% for a
        // session that was logged freestyle.
        completion_pct: plannedSets ? Math.round((totalSets / plannedSets) * 100) : null,
        prs,
      },
    },
  });
}));

// POST /workout-log/sessions
router.post('/workout-log/sessions', auth, requireRole('admin', 'manager', 'trainer'), validate(sessionCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Same PAR-Q + Informed Consent gate as plan assignment — logging a
  // session is training just as much as following an assigned plan, so it
  // gets the same clearance rule: explicit medical blocks stop the action,
  // missing paperwork proceeds with warnings for the UI to surface.
  const { blocked, warnings } = await checkScreeningGate(req, b.client_id);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  // Auto-link the client's single active plan assignment only when the
  // field was omitted entirely — an explicit null (freestyle, opted out
  // of the client's active plan) or an explicit id is left as-is, so the
  // frontend can distinguish "didn't say" from "said no plan".
  const orgId = orgIdOf(req);
  let assignmentId = b.workout_assignment_id;
  if (assignmentId === undefined) {
    const { rows: activeRows } = await pool.query(
      `SELECT id FROM workout_assignments WHERE client_id = $1 AND status = 'active'`,
      [b.client_id]
    );
    assignmentId = activeRows.length === 1 ? activeRows[0].id : null;
  }

  const { rows } = await pool.query(
    `INSERT INTO workout_sessions (
       client_id, trainer_id, workout_assignment_id, session_date, program_name, workout_day, notes, created_by, organization_id
     ) VALUES ($1, (SELECT trainer_id FROM pt_clients WHERE id = $1), $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8)
     RETURNING *`,
    [b.client_id, assignmentId, b.session_date || null, b.program_name || null, b.workout_day || null, b.notes || null, req.user.id, orgId]
  );
  await logActivity(req, 'workout_log.session.create', 'workout_sessions', rows[0].id, { client_id: b.client_id });
  res.status(201).json({ data: rows[0], screening_warnings: warnings });
}));

// GET /workout-log/sessions/:sessionId/planned-day-options — the distinct
// weekday names this session's linked plan prescribes exercises for, so
// the frontend can render a constrained day picker instead of free text.
router.get('/workout-log/sessions/:sessionId/planned-day-options', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: sessionRows } = await pool.query(
    `SELECT workout_assignment_id FROM workout_sessions WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.sessionId, scope.orgId] : [req.params.sessionId]
  );
  const session = sessionRows[0];
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (!session.workout_assignment_id) return res.json({ data: [] });

  const { rows: planRows } = await pool.query(
    `SELECT wp.id FROM workout_assignments wa JOIN workout_plans wp ON wp.id = wa.workout_plan_id WHERE wa.id = $1`,
    [session.workout_assignment_id]
  );
  if (!planRows[0]) return res.json({ data: [] });

  const { rows: dayRows } = await pool.query(
    'SELECT DISTINCT day_of_week FROM workout_exercises WHERE workout_plan_id = $1 ORDER BY day_of_week',
    [planRows[0].id]
  );
  res.json({ data: dayRows.map((r) => WEEKDAYS[r.day_of_week - 1]).filter(Boolean) });
}));

// PATCH /workout-log/sessions/:id
router.patch('/workout-log/sessions/:id', auth, requireRole('admin', 'manager', 'trainer'), validate(sessionUpdateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const allowed = ['session_date', 'program_name', 'workout_day', 'notes', 'duration_minutes', 'status'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const scope = tenantScope(req);
  let whereGuard = '';
  if (scope.applyFilter) { params.push(scope.orgId); whereGuard = ` AND organization_id = $${params.length}`; }
  const { rows } = await pool.query(`UPDATE workout_sessions SET ${sets.join(', ')} WHERE id = $1${whereGuard} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (b.status !== undefined && rows[0].workout_assignment_id) {
    await recomputeAssignmentProgress(rows[0].workout_assignment_id);
  }
  res.json({ data: rows[0] });
}));

// DELETE /workout-log/sessions/:id
router.delete('/workout-log/sessions/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows } = await pool.query(
    `DELETE FROM workout_sessions WHERE id = $1${guard} RETURNING id, client_id, workout_assignment_id`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (rows[0].workout_assignment_id) await recomputeAssignmentProgress(rows[0].workout_assignment_id);
  await logActivity(req, 'workout_log.session.delete', 'workout_sessions', req.params.id, { client_id: rows[0].client_id });
  res.json({ message: 'Session deleted' });
}));

// ─── Exercises within a session ─────────────────────────────

// POST /workout-log/sessions/:sessionId/exercises
router.post('/workout-log/sessions/:sessionId/exercises', auth, requireRole('admin', 'manager', 'trainer'), validate(exerciseAddSchema), wrap(async (req, res) => {
  const { sessionId } = req.params;
  const b = req.body;
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: sessionRows } = await pool.query(
    `SELECT id FROM workout_sessions WHERE id = $1${guard}`,
    scope.applyFilter ? [sessionId, scope.orgId] : [sessionId]
  );
  if (!sessionRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const { rows: orderRows } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM workout_session_exercises WHERE session_id = $1',
    [sessionId]
  );

  const { rows } = await pool.query(
    `INSERT INTO workout_session_exercises (session_id, exercise_id, exercise_name, sort_order, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *, '[]'::json AS sets`,
    [sessionId, b.exercise_id || null, b.exercise_name, orderRows[0].next_order, b.notes || null]
  );
  res.status(201).json({ data: rows[0] });
}));

// DELETE /workout-log/exercises/:id
router.delete('/workout-log/exercises/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const scope = tenantScope(req);
  let query = 'DELETE FROM workout_session_exercises WHERE id = $1 RETURNING id';
  let params = [req.params.id];
  if (scope.applyFilter) {
    // Gate on the parent session's org — the leaf table has no org column.
    query = `DELETE FROM workout_session_exercises wse
               USING workout_sessions ws
              WHERE wse.id = $1 AND ws.id = wse.session_id AND ws.organization_id = $2
              RETURNING wse.id`;
    params = [req.params.id, scope.orgId];
  }
  const { rows } = await pool.query(query, params);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ message: 'Exercise removed' });
}));

// ─── Sets ───────────────────────────────────────────────────

// POST /workout-log/exercises/:sessionExerciseId/sets
router.post('/workout-log/exercises/:sessionExerciseId/sets', auth, requireRole('admin', 'manager', 'trainer'), validate(setCreateSchema), wrap(async (req, res) => {
  const { sessionExerciseId } = req.params;
  const b = req.body;

  const scope = tenantScope(req);
  const exGuard = scope.applyFilter ? ' AND ws.organization_id = $2' : '';
  const { rows: exRows } = await pool.query(
    `SELECT wse.exercise_id, wse.exercise_name, ws.client_id
       FROM workout_session_exercises wse
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE wse.id = $1${exGuard}`,
    scope.applyFilter ? [sessionExerciseId, scope.orgId] : [sessionExerciseId]
  );
  const ex = exRows[0];
  if (!ex) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  let prFlags = { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };
  if (b.completed && b.weight_kg != null && b.reps != null) {
    prFlags = await computePrFlags(pool, ex.client_id, ex.exercise_id, ex.exercise_name, b.weight_kg, b.reps, null);
  }

  const { rows } = await pool.query(
    `INSERT INTO workout_sets (
       session_exercise_id, set_number, weight_kg, reps, rpe, rir, tempo, rest_seconds, completed, notes,
       is_pr_weight, is_pr_reps, is_pr_volume
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      sessionExerciseId, b.set_number, b.weight_kg ?? null, b.reps ?? null, b.rpe ?? null, b.rir ?? null,
      b.tempo || null, b.rest_seconds ?? null, b.completed ?? false, b.notes || null,
      prFlags.is_pr_weight, prFlags.is_pr_reps, prFlags.is_pr_volume,
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

// PATCH /workout-log/sets/:id
router.patch('/workout-log/sets/:id', auth, requireRole('admin', 'manager', 'trainer'), validate(setUpdateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const scope = tenantScope(req);
  const setGuard = scope.applyFilter ? ' AND ws.organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT s.*, wse.exercise_id, wse.exercise_name, ws.client_id
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE s.id = $1${setGuard}`,
    scope.applyFilter ? [id, scope.orgId] : [id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const merged = {
    weight_kg: b.weight_kg !== undefined ? b.weight_kg : existing.weight_kg,
    reps: b.reps !== undefined ? b.reps : existing.reps,
    completed: b.completed !== undefined ? b.completed : existing.completed,
  };

  let prFlags = { is_pr_weight: existing.is_pr_weight, is_pr_reps: existing.is_pr_reps, is_pr_volume: existing.is_pr_volume };
  if (merged.completed && merged.weight_kg != null && merged.reps != null) {
    prFlags = await computePrFlags(pool, existing.client_id, existing.exercise_id, existing.exercise_name, merged.weight_kg, merged.reps, id);
  } else if (!merged.completed) {
    prFlags = { is_pr_weight: false, is_pr_reps: false, is_pr_volume: false };
  }

  const allowed = ['weight_kg', 'reps', 'rpe', 'rir', 'tempo', 'rest_seconds', 'completed', 'notes'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  for (const [col, val] of Object.entries(prFlags)) { params.push(val); sets.push(`${col} = $${params.length}`); }
  sets.push('updated_at = NOW()');

  const { rows } = await pool.query(`UPDATE workout_sets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

// DELETE /workout-log/sets/:id
router.delete('/workout-log/sets/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const scope = tenantScope(req);
  let query = 'DELETE FROM workout_sets WHERE id = $1 RETURNING id';
  let params = [req.params.id];
  if (scope.applyFilter) {
    // Gate on the parent session's org — the leaf table has no org column.
    query = `DELETE FROM workout_sets s
               USING workout_session_exercises wse, workout_sessions ws
              WHERE s.id = $1 AND wse.id = s.session_exercise_id AND ws.id = wse.session_id
                AND ws.organization_id = $2
              RETURNING s.id`;
    params = [req.params.id, scope.orgId];
  }
  const { rows } = await pool.query(query, params);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ message: 'Set deleted' });
}));

// ─── Previous workout + progress ────────────────────────────

// GET /workout-log/previous?client_id=&exercise_id=&exercise_name=&exclude_session_id=
// Powers the "Previous" side-by-side panel and auto-fill.
// GET /workout-log/today — the trainer's roster for one day.
//
// Answers the only question that matters when a trainer opens the app on the
// gym floor: who am I training, what is their workout, and have I started it?
// Before this, that took a client search, then their profile, then Workout
// Log, then New Session, then picking the day from a dropdown — five screens
// to reach the one thing they do every day.
//
// One row per client who has ANYTHING on today, from the three places a
// studio records that a client is coming in:
//
//   booked    — a slot in pt_sessions, which carries a real start time
//   programme — an active assignment whose plan prescribes this weekday
//   enrolled  — pt_clients.preferred_training_days naming this weekday, with
//               preferred_workout_time as the time they usually arrive
//
// This used to be the middle one alone, as an INNER JOIN on
// workout_assignments — so a client with a booked 6am slot and no programme
// yet did not appear at all, and could not be started from here. That is the
// most common state for a new client: enrolled, paid, training tomorrow, plan
// not written yet.
//
// The three are deduplicated to one row per client, keeping the most specific
// answer: a booked slot beats a programme day beats an enrolment habit. The
// time comes from whichever source had one.
//
// ORDER is the point of the whole endpoint now. The trainer works through the
// day in clock order, so: timed rows ascending, untimed rows after them (no
// one has said when, so they cannot be interleaved honestly), rest days last.
// It is done here rather than in each client so the dashboard card and the
// full list cannot disagree about who is next.
//
// `planned_exercises` is what the programme prescribes for that weekday, and
// `session` is the log if one already exists, so a client can be resumed
// rather than double-started.
//
// Scoped like every other read here: tenant first, then — for a trainer who
// is not an admin — their own clients only.
router.get('/workout-log/today', auth, wrap(async (req, res) => {
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : studioToday();

  // ISO weekday: Postgres ISODOW gives Monday=1, matching
  // workout_exercises.day_of_week and the WEEKDAYS array above.
  const { rows: dowRows } = await pool.query('SELECT EXTRACT(ISODOW FROM $1::date)::int AS dow', [date]);
  const dow = dowRows[0].dow;

  // 'Mon' … 'Sun', the literal tokens the enrolment form stores in
  // preferred_training_days. Derived from the requested date rather than from
  // "now", so ?date= still works.
  const dayToken = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dow - 1];

  const params = [date, dow, dayToken];
  const scope = tenantScope(req);
  // $4 when filtering. Each source carries its own org column, so the filter
  // is applied per-source inside the union rather than once at the end —
  // otherwise a foreign row could enter the candidate set and be deduplicated
  // against a local one.
  const org = scope.applyFilter ? (params.push(scope.orgId), `$${params.length}`) : null;

  // A trainer who is not admin/manager sees only their own clients. Mirrors
  // the ownership rule used across pt-os reads. Applied once, at the end,
  // because it is a property of the CLIENT rather than of the source.
  let trainerClause = '';
  if (!['admin', 'manager', 'super_admin'].includes(req.user.role) && req.user.trainer_id) {
    params.push(req.user.trainer_id);
    trainerClause = `AND c.trainer_id = $${params.length}`;
  }

  // pt_clients.preferred_workout_time is free text holding TWO formats, and
  // sorting it as text is nonsense: the enrolment form's dropdown writes
  // '6:00 AM' while its custom field is an <input type="time"> that writes
  // '06:00'. As strings, '1:00 PM' < '5:00 AM' — the afternoon slot sorts
  // before the dawn one — and slicing five characters off '5:00 AM' yields
  // '5:00 '. Both are parsed to a real TIME here, and anything that matches
  // neither shape becomes NULL so it sorts last rather than corrupting the
  // order of the rows around it.
  const PREFERRED_TIME = `
    CASE
      WHEN c2.preferred_workout_time ~* '^[0-9]{1,2}:[0-9]{2}\\s*(AM|PM)$'
        THEN to_timestamp(trim(c2.preferred_workout_time), 'HH12:MI AM')::time
      WHEN c2.preferred_workout_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$'
        THEN c2.preferred_workout_time::time
      ELSE NULL
    END`;

  const { rows } = await pool.query(
    `WITH candidates AS (
       -- Booked: a real appointment, already a TIME column.
       SELECT s.client_id,
              s.start_time       AS start_time,
              1                  AS source_rank
         FROM pt_sessions s
        WHERE s.session_date = $1::date
          AND s.deleted_at IS NULL
          AND s.status <> 'cancelled'
          ${org ? `AND s.organization_id = ${org}` : ''}

       UNION ALL

       -- Programme: the plan prescribes this weekday. No time — a plan says
       -- which day, never which hour.
       SELECT wa.client_id, NULL::time, 2
         FROM workout_assignments wa
         JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        WHERE wa.status = 'active'
          AND wa.start_date <= $1::date
          AND (wa.end_date IS NULL OR wa.end_date >= $1::date)
          ${org ? `AND wa.organization_id = ${org}` : ''}

       UNION ALL

       -- Enrolment: the day picker on the enrolment form, which is required,
       -- so every enrolled client has one. Whole-token match — a LIKE would
       -- let 'Thursday-ish' match 'Thu'.
       SELECT c2.id, ${PREFERRED_TIME}, 3
         FROM pt_clients c2
        WHERE c2.deleted_at IS NULL
          AND c2.status = 'active'
          AND c2.preferred_training_days IS NOT NULL
          AND $3 = ANY(string_to_array(replace(c2.preferred_training_days, ' ', ''), ','))
          ${org ? `AND c2.organization_id = ${org}` : ''}
     ),
     -- One row per client. MIN(source_rank) keeps the most specific reason
     -- they are on the list; MIN(start_time) keeps the earliest time any
     -- source gave, and stays NULL when none did.
     roster AS (
       SELECT client_id,
              MIN(start_time)  AS start_time,
              MIN(source_rank) AS source_rank
         FROM candidates
        GROUP BY client_id
     )
     SELECT r.client_id,
            r.start_time,
            r.source_rank,
            c.name               AS client_name,
            c.photo_url          AS client_photo,
            wa.id                AS assignment_id,
            wp.id                AS plan_id,
            wp.name              AS plan_name,
            wa.progress_pct,
            ws.id                AS session_id,
            ws.status            AS session_status,
            COALESCE((SELECT COUNT(*) FROM workout_exercises we
                       WHERE we.workout_plan_id = wp.id AND we.day_of_week = $2), 0) AS planned_exercises
       FROM roster r
       JOIN pt_clients c ON c.id = r.client_id AND c.deleted_at IS NULL
       -- LEFT, not INNER: a client can be on today's roster with no programme
       -- at all, which is the state this endpoint used to make invisible.
       -- LATERAL with LIMIT 1 because two active assignments would otherwise
       -- fan one client into two rows.
       LEFT JOIN LATERAL (
         SELECT a.id, a.workout_plan_id, a.progress_pct
           FROM workout_assignments a
          WHERE a.client_id = r.client_id
            AND a.status = 'active'
            AND a.start_date <= $1::date
            AND (a.end_date IS NULL OR a.end_date >= $1::date)
          ORDER BY a.start_date DESC
          LIMIT 1
       ) wa ON TRUE
       LEFT JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       -- Nothing stops a client having two logs on one date, and a plain join
       -- fans them into two rows. Tested against live data, where one client
       -- already has two. An in-progress session wins, so "Resume" points at
       -- the live one.
       LEFT JOIN LATERAL (
         SELECT s.id, s.status
           FROM workout_sessions s
          WHERE s.client_id = r.client_id AND s.session_date = $1::date
          ORDER BY (s.status = 'in_progress') DESC, s.created_at DESC
          LIMIT 1
       ) ws ON TRUE
      WHERE TRUE ${trainerClause}
      -- Clock order. Rest days (nothing prescribed and no booking) sink to the
      -- bottom; among the rest, timed before untimed, then by name so the list
      -- is stable between refreshes.
      ORDER BY
        (r.source_rank = 2 AND wp.id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM workout_exercises we
            WHERE we.workout_plan_id = wp.id AND we.day_of_week = $2)),
        (r.start_time IS NULL),
        r.start_time,
        c.name`,
    params
  );

  res.json({
    data: {
      date,
      day_of_week: WEEKDAYS[dow - 1],
      clients: rows.map((r) => {
        const planned = Number(r.planned_exercises);
        // Why this client is on today's list. The UI reads it to label the
        // row, and it is the server's answer rather than something inferred
        // from which fields happen to be null.
        const source = r.source_rank === 1 ? 'booked'
          : r.source_rank === 2 ? 'programme'
          : 'enrolled';
        return {
          assignment_id: r.assignment_id,
          client_id: r.client_id,
          client_name: r.client_name,
          client_photo: r.client_photo,
          plan_id: r.plan_id,
          plan_name: r.plan_name,
          progress_pct: r.progress_pct,
          planned_exercises: planned,
          // 'HH:MM', or null when nobody has said when. Only a booked slot or
          // an enrolment preference carries one; a programme names a weekday,
          // never an hour.
          start_time: r.start_time ? String(r.start_time).slice(0, 5) : null,
          source,
          // A rest day is a real answer, not a missing one: the client is here
          // because a programme covers them, and that programme prescribes
          // nothing for this weekday.
          //
          // Narrowed from `planned === 0`, which was safe while every row came
          // from an assignment and is not now: a client with a booked 6am slot
          // and no plan also has zero planned exercises, and calling that a
          // rest day would grey out and sink the one row with a real
          // appointment on it.
          is_rest_day: source === 'programme' && planned === 0,
          session_id: r.session_id,
          session_status: r.session_status,
        };
      }),
    },
  });
}));

router.get('/workout-log/previous', auth, wrap(async (req, res) => {
  const { client_id, exercise_id, exercise_name, exclude_session_id } = req.query;
  if (!client_id || (!exercise_id && !exercise_name)) {
    return res.status(400).json({ error: { code: 'MISSING_PARAMS' } });
  }
  const matchClause = exercise_id ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exercise_id || exercise_name;
  const params = [client_id, matchParam];
  let excludeClause = '';
  if (exclude_session_id) { params.push(exclude_session_id); excludeClause = `AND ws.id != $${params.length}`; }
  const scope = tenantScope(req);
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = `AND ws.organization_id = $${params.length}`; }

  const { rows: exRows } = await pool.query(
    `SELECT wse.id AS session_exercise_id, ws.session_date
       FROM workout_session_exercises wse
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} ${excludeClause} ${orgClause}
      ORDER BY ws.session_date DESC, wse.created_at DESC
      LIMIT 1`,
    params
  );
  if (!exRows[0]) return res.json({ data: null });

  const { rows: setRows } = await pool.query(
    'SELECT * FROM workout_sets WHERE session_exercise_id = $1 ORDER BY set_number ASC',
    [exRows[0].session_exercise_id]
  );
  res.json({ data: { session_date: exRows[0].session_date, sets: setRows } });
}));

// GET /workout-log/progress?client_id=&exercise_id=&exercise_name=
// Per-session best set + estimated 1RM + volume — feeds the exercise
// progress charts (e.g. Bench/Squat/Deadlift progress).
router.get('/workout-log/progress', auth, wrap(async (req, res) => {
  const { client_id, exercise_id, exercise_name } = req.query;
  if (!client_id || (!exercise_id && !exercise_name)) {
    return res.status(400).json({ error: { code: 'MISSING_PARAMS' } });
  }
  const matchClause = exercise_id ? 'wse.exercise_id = $2' : 'wse.exercise_name = $2';
  const matchParam = exercise_id || exercise_name;
  const scope = tenantScope(req);
  const params = [client_id, matchParam];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = `AND ws.organization_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT ws.session_date, s.weight_kg, s.reps
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND ${matchClause} AND s.completed = true
        AND s.weight_kg IS NOT NULL AND s.reps IS NOT NULL ${orgClause}
      ORDER BY ws.session_date ASC`,
    params
  );

  const bySession = new Map();
  for (const r of rows) {
    const key = String(r.session_date).slice(0, 10);
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(r);
  }
  const data = Array.from(bySession.entries()).map(([session_date, sets]) => {
    const volume = sets.reduce((sum, r) => sum + Number(r.weight_kg) * Number(r.reps), 0);
    const best = sets.reduce((b, r) => (b == null || Number(r.weight_kg) > Number(b.weight_kg) ? r : b), null);
    return {
      session_date,
      best_weight: Number(best.weight_kg),
      best_reps: Number(best.reps),
      est_1rm: calc1RM(Number(best.weight_kg), Number(best.reps), 'epley'),
      volume: Math.round(volume * 100) / 100,
    };
  });
  res.json({ data });
}));

// GET /workout-log/volume-summary?client_id=&group_by=week|month
// Feeds the Weekly/Monthly Training Volume charts (all exercises combined).
router.get('/workout-log/volume-summary', auth, wrap(async (req, res) => {
  const { client_id, group_by } = req.query;
  if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
  const trunc = group_by === 'month' ? 'month' : 'week';
  const scope = tenantScope(req);
  const params = [client_id, trunc];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = `AND ws.organization_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT date_trunc($2, ws.session_date)::date AS period,
            SUM(s.weight_kg * s.reps) AS volume,
            COUNT(DISTINCT ws.id) AS session_count
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
      WHERE ws.client_id = $1 AND s.completed = true AND s.weight_kg IS NOT NULL AND s.reps IS NOT NULL ${orgClause}
      GROUP BY period
      ORDER BY period ASC`,
    params
  );
  res.json({ data: rows });
}));

// GET /workout-log/analytics?client_id=&weeks=12
//
// The four questions a trainer asks about a client, answered from the log:
// did they show up, are they getting stronger, am I training everything, and
// is anything overcooked.
//
// One endpoint rather than four, because the screen shows them together and
// four round trips on a phone in a gym is four chances to see a spinner. The
// arithmetic is in ./training-analytics; this assembles the rows it needs.
//
// Everything returned is either MEASURED from the log or a range the studio
// stored. Nothing is modelled. There is deliberately no "fatigue score" and no
// "recovery percentage" — those would be invented numbers printed beside real
// ones in the same typeface, and a trainer would have no way to tell them
// apart. Recovery is reported as days since a muscle was last trained, which
// is a fact.
router.get('/workout-log/analytics', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
  if (!await clientInOrg(req, client_id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }

  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 12, 1), 52);
  const asOf = (req.query.as_of && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of))
    ? req.query.as_of
    : studioToday();

  const scope = tenantScope(req);
  const orgId = scope.applyFilter ? scope.orgId : null;

  // The window. Sets and sessions older than this are not read at all rather
  // than read and filtered — a client two years in should not pay for it.
  const since = new Date(`${weekStart(asOf)}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - (weeks - 1) * 7);
  const sinceDate = since.toISOString().slice(0, 10);

  const [sessionRows, setRows, prRows, planRows, landmarkRows] = await Promise.all([
    pool.query(
      `SELECT ws.session_date, ws.status
         FROM workout_sessions ws
        WHERE ws.client_id = $1 AND ws.session_date >= $2::date
          ${orgId ? 'AND ws.organization_id = $3' : ''}
        ORDER BY ws.session_date ASC`,
      orgId ? [client_id, sinceDate, orgId] : [client_id, sinceDate],
    ),

    // Hard sets per muscle over the window, plus the latest date each muscle
    // was worked. GROUP BY in SQL rather than in JS: this is the one query
    // whose row count grows with every set the client has ever logged.
    pool.query(
      `SELECT e.target_muscle,
              COUNT(*)::int      AS sets,
              MAX(ws.session_date) AS last_date
         FROM workout_sets s
         JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = wse.session_id
         LEFT JOIN exercises e ON e.id = wse.exercise_id
        WHERE ws.client_id = $1 AND s.completed = true AND ws.session_date >= $2::date
          ${orgId ? 'AND ws.organization_id = $3' : ''}
        GROUP BY e.target_muscle`,
      orgId ? [client_id, sinceDate, orgId] : [client_id, sinceDate],
    ),

    pool.query(
      `SELECT ws.session_date, wse.exercise_name, s.weight_kg, s.reps,
              s.is_pr_weight, s.is_pr_reps, s.is_pr_volume
         FROM workout_sets s
         JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = wse.session_id
        WHERE ws.client_id = $1 AND s.completed = true
          AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
          ${orgId ? 'AND ws.organization_id = $2' : ''}
        ORDER BY ws.session_date DESC
        LIMIT 200`,
      orgId ? [client_id, orgId] : [client_id],
    ),

    // The active programme, and the days it actually prescribes. Counted from
    // real rows rather than from sessions_per_week, which is a label a trainer
    // typed and can disagree with the programme underneath it.
    pool.query(
      `SELECT wa.start_date, wp.id AS plan_id, wp.name AS plan_name, wp.duration_weeks,
              COALESCE(ARRAY(
                SELECT DISTINCT we.day_of_week FROM workout_exercises we
                 WHERE we.workout_plan_id = wp.id AND we.week_number = 1
                 ORDER BY we.day_of_week
              ), '{}') AS planned_days
         FROM workout_assignments wa
         JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        WHERE wa.client_id = $1 AND wa.status = 'active'
          ${orgId ? 'AND wa.organization_id = $2' : ''}
        ORDER BY wa.start_date DESC
        LIMIT 1`,
      orgId ? [client_id, orgId] : [client_id],
    ),

    // The studio's row wins over the platform default. DISTINCT ON with the
    // NULLs sorted last is what expresses "mine, else the shared one" in a
    // single pass.
    pool.query(
      `SELECT DISTINCT ON (target_muscle) target_muscle, mev_sets, mrv_sets, organization_id
         FROM muscle_volume_landmarks
        WHERE organization_id IS NULL ${orgId ? 'OR organization_id = $1' : ''}
        ORDER BY target_muscle, organization_id NULLS LAST`,
      orgId ? [orgId] : [],
    ),
  ]);

  const landmarks = new Map(landmarkRows.rows.map((r) => [r.target_muscle, r]));
  const plan = planRows.rows[0] || null;
  const plannedDays = plan ? (plan.planned_days || []).map(Number) : [];

  const adherenceOut = plan
    ? adherence(sessionRows.rows, {
      perWeek: plannedDays.length,
      startDate: plan.start_date,
      asOf,
      weeks,
    })
    // No active programme means there is nothing to be adherent TO. Reporting
    // 0% would read as a client who never turns up.
    : { planned: 0, completed: 0, pct: null, weeks: [] };

  res.json({
    data: {
      as_of: asOf,
      weeks,
      plan: plan ? { id: plan.plan_id, name: plan.plan_name, duration_weeks: plan.duration_weeks } : null,
      adherence: adherenceOut,
      this_week: plan ? missedDays(plannedDays, sessionRows.rows, { weekOf: asOf, asOf }) : null,
      prs: prTimeline(prRows.rows),
      ...muscleWeek(setRows.rows, { asOf, landmarks }),
    },
  });
}));

// GET /workout-log/landmarks — the studio's weekly set ranges, resolved.
router.get('/workout-log/landmarks', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const orgId = scope.applyFilter ? scope.orgId : null;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (target_muscle)
            target_muscle, mev_sets, mrv_sets,
            (organization_id IS NOT NULL) AS is_custom
       FROM muscle_volume_landmarks
      WHERE organization_id IS NULL ${orgId ? 'OR organization_id = $1' : ''}
      ORDER BY target_muscle, organization_id NULLS LAST`,
    orgId ? [orgId] : [],
  );
  res.json({ data: rows });
}));

// PUT /workout-log/landmarks/:muscle — the studio's own range for one muscle.
//
// Writes a studio-owned row rather than editing the shared default, so one
// studio's judgement never becomes another's. Clearing both values is allowed
// and means "no range" — a blank is an honest answer, and better than a pair
// of numbers nobody chose.
router.put('/workout-log/landmarks/:muscle',
  auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
    const orgId = orgIdOf(req);
    if (!orgId) {
      // A platform operator editing the shared defaults is a different action
      // with a different blast radius, and it is not this endpoint.
      return res.status(403).json({ error: { code: 'ORG_REQUIRED', message: 'A studio context is required' } });
    }

    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;      // undefined = malformed
    };
    const mev = num(req.body.mev_sets);
    const mrv = num(req.body.mrv_sets);
    if (mev === undefined || mrv === undefined) {
      return res.status(400).json({ error: { code: 'INVALID_SETS', message: 'Sets must be whole numbers or blank' } });
    }
    if (mev != null && mrv != null && mev > mrv) {
      return res.status(400).json({ error: { code: 'INVALID_RANGE', message: 'The minimum cannot exceed the maximum' } });
    }
    if ([mev, mrv].some((v) => v != null && (v < 0 || v > 60))) {
      return res.status(400).json({ error: { code: 'OUT_OF_RANGE', message: 'Sets must be between 0 and 60' } });
    }

    const { rows } = await pool.query(
      `INSERT INTO muscle_volume_landmarks (id, organization_id, target_muscle, mev_sets, mrv_sets, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), target_muscle)
       DO UPDATE SET mev_sets = EXCLUDED.mev_sets, mrv_sets = EXCLUDED.mrv_sets,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING target_muscle, mev_sets, mrv_sets`,
      [randomUUID(), orgId, String(req.params.muscle).toLowerCase(), mev, mrv, req.user.id],
    );
    res.json({ data: rows[0] });
  }));

// DELETE /workout-log/landmarks/:muscle — drop this studio's override.
//
// Not the same action as clearing the range, and the difference matters. A PUT
// with two nulls stores "this muscle has no range" and the analytics screen
// stops judging it. This removes the studio's row entirely, so the shared
// starting range comes back — which is what a trainer wants after editing one
// by mistake, and there is otherwise no route back to a number they have
// overwritten.
router.delete('/workout-log/landmarks/:muscle',
  auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
    const orgId = orgIdOf(req);
    if (!orgId) {
      return res.status(403).json({ error: { code: 'ORG_REQUIRED', message: 'A studio context is required' } });
    }
    // organization_id in the WHERE, not just the id: without it this deletes
    // the shared default row for every studio on the platform.
    await pool.query(
      'DELETE FROM muscle_volume_landmarks WHERE organization_id = $1 AND target_muscle = $2',
      [orgId, String(req.params.muscle).toLowerCase()],
    );

    const { rows } = await pool.query(
      `SELECT target_muscle, mev_sets, mrv_sets, false AS is_custom
         FROM muscle_volume_landmarks
        WHERE organization_id IS NULL AND target_muscle = $1`,
      [String(req.params.muscle).toLowerCase()],
    );
    // No shared default for this muscle is a legitimate outcome — some ship
    // without one on purpose. The row simply has no range now.
    res.json({ data: rows[0] ?? { target_muscle: req.params.muscle, mev_sets: null, mrv_sets: null, is_custom: false } });
  }));

// POST /workout-log/weekly-report — build the PDF a trainer sends a client.
//
// A POST, not a GET, because it writes a file. Keyed by client and week, so
// pressing the button twice overwrites rather than littering storage with a
// file per tap.
//
// The trainer's own note is optional and passed in. Everything else is read
// from the log, and nothing is projected: a progress report is exactly where
// "at this rate you will squat 140 kg by October" wants to appear, and two
// months of extrapolation from four points is not a forecast. Inside a PDF it
// would read as a record rather than as a guess.
router.post('/workout-log/weekly-report',
  auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
    const { client_id, week_start, coach_note } = req.body;
    if (!client_id) return res.status(400).json({ error: { code: 'MISSING_CLIENT_ID' } });
    if (!await clientInOrg(req, client_id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    }

    const start = weekStart(week_start || studioToday());
    if (!start) return res.status(400).json({ error: { code: 'INVALID_WEEK' } });
    const endDate = new Date(`${start}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + 6);
    const end = endDate.toISOString().slice(0, 10);

    const scope = tenantScope(req);
    const orgId = scope.applyFilter ? scope.orgId : null;

    const [clientRows, sessionRows, prRows, setRows, planRows, landmarkRows] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.organization_id, o.name AS studio_name
           FROM pt_clients c LEFT JOIN organizations o ON o.id = c.organization_id
          WHERE c.id = $1`,
        [client_id],
      ),
      // Volume and set counts per session come from the sets, not from a
      // stored total — nothing keeps a denormalised total in step with an
      // edited set, and a report that disagrees with the log is worse than none.
      pool.query(
        `SELECT ws.session_date, ws.status, ws.duration_minutes, ws.notes,
                COALESCE(SUM(s.weight_kg * s.reps) FILTER (WHERE s.completed), 0) AS total_volume,
                COUNT(s.id) FILTER (WHERE s.completed)::int AS set_count
           FROM workout_sessions ws
           LEFT JOIN workout_session_exercises wse ON wse.session_id = ws.id
           LEFT JOIN workout_sets s ON s.session_exercise_id = wse.id
          WHERE ws.client_id = $1 AND ws.session_date BETWEEN $2::date AND $3::date
            ${orgId ? 'AND ws.organization_id = $4' : ''}
          GROUP BY ws.id, ws.session_date, ws.status, ws.duration_minutes, ws.notes
          ORDER BY ws.session_date ASC`,
        orgId ? [client_id, start, end, orgId] : [client_id, start, end],
      ),
      pool.query(
        `SELECT ws.session_date, wse.exercise_name, s.weight_kg, s.reps,
                s.is_pr_weight, s.is_pr_reps, s.is_pr_volume
           FROM workout_sets s
           JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
           JOIN workout_sessions ws ON ws.id = wse.session_id
          WHERE ws.client_id = $1 AND s.completed = true
            AND ws.session_date BETWEEN $2::date AND $3::date
            AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
            ${orgId ? 'AND ws.organization_id = $4' : ''}`,
        orgId ? [client_id, start, end, orgId] : [client_id, start, end],
      ),
      pool.query(
        `SELECT e.target_muscle, COUNT(*)::int AS sets, MAX(ws.session_date) AS last_date
           FROM workout_sets s
           JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
           JOIN workout_sessions ws ON ws.id = wse.session_id
           LEFT JOIN exercises e ON e.id = wse.exercise_id
          WHERE ws.client_id = $1 AND s.completed = true
            AND ws.session_date BETWEEN $2::date AND $3::date
            ${orgId ? 'AND ws.organization_id = $4' : ''}
          GROUP BY e.target_muscle`,
        orgId ? [client_id, start, end, orgId] : [client_id, start, end],
      ),
      pool.query(
        `SELECT wa.start_date,
                COALESCE(ARRAY(
                  SELECT DISTINCT we.day_of_week FROM workout_exercises we
                   WHERE we.workout_plan_id = wp.id AND we.week_number = 1
                   ORDER BY we.day_of_week
                ), '{}') AS planned_days
           FROM workout_assignments wa
           JOIN workout_plans wp ON wp.id = wa.workout_plan_id
          WHERE wa.client_id = $1 AND wa.status = 'active'
            ${orgId ? 'AND wa.organization_id = $2' : ''}
          ORDER BY wa.start_date DESC LIMIT 1`,
        orgId ? [client_id, orgId] : [client_id],
      ),
      pool.query(
        `SELECT DISTINCT ON (target_muscle) target_muscle, mev_sets, mrv_sets
           FROM muscle_volume_landmarks
          WHERE organization_id IS NULL ${orgId ? 'OR organization_id = $1' : ''}
          ORDER BY target_muscle, organization_id NULLS LAST`,
        orgId ? [orgId] : [],
      ),
    ]);

    const client = clientRows.rows[0];
    if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

    const plan = planRows.rows[0];
    const landmarks = new Map(landmarkRows.rows.map((r) => [r.target_muscle, r]));
    // Attendance for THIS week only. What actually bounds it is `asOf: end` —
    // adherence counts weeks between startDate and asOf, and those are six
    // days apart, so it yields one row whatever `weeks` says. `weeks: 1` is
    // belt and braces, not the guard; widening the date window is what would
    // print the whole block's attendance under a single week's dates.
    const week = plan
      ? adherence(sessionRows.rows, {
        perWeek: (plan.planned_days || []).length,
        startDate: start,
        asOf: end,
        weeks: 1,
      })
      : null;

    const url = await generateWeeklyProgressPdf({
      client,
      studioName: client.studio_name,
      weekStart: start,
      weekEnd: end,
      sessions: sessionRows.rows,
      adherence: week,
      prs: prTimeline(prRows.rows),
      muscles: muscleWeek(setRows.rows, { asOf: end, landmarks }).muscles,
      coachNote: coach_note,
    });

    logActivity(req, 'weekly_progress_report', 'pt_client', client_id, { week_start: start });
    res.json({ data: { url, week_start: start, week_end: end } });
  }));

module.exports = router;
