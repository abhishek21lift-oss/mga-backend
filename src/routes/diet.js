// src/routes/diet.js — Diet/Nutrition Plans API
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOrManager } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const { clientInOrg } = require('../lib/orgGuard');

// ─── MEALS ───────────────────────────────────────────────────

// GET /api/diet/meals
router.get('/meals', auth, async (req, res, next) => {
  try {
    const { meal_type, search } = req.query;
    const conds = ['is_active = true'];
    const params = [];
    let p = 1;

    if (meal_type) { conds.push(`meal_type = $${p++}`); params.push(meal_type); }
    if (search)    { conds.push(`name ILIKE $${p++}`);   params.push(`%${search}%`); }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM meals WHERE ${conds.join(' AND ')} ORDER BY meal_type, name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// POST /api/diet/meals
router.post('/meals', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.name?.trim())
      return res.status(400).json({ error: 'Meal name required' });

    const { rows } = await pool.query(`
      INSERT INTO meals (id, name, description, meal_type, calories,
        protein_g, carbs_g, fats_g, serving_size, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [randomUUID(), d.name.trim(), d.description || null, d.meal_type || 'breakfast',
       parseInt(d.calories) || 0, parseFloat(d.protein_g) || 0,
       parseFloat(d.carbs_g) || 0, parseFloat(d.fats_g) || 0,
       d.serving_size || null, req.user.id]
    );
    res.status(201).json({ message: 'Meal created', meal: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── DIET TEMPLATES ──────────────────────────────────────────

// GET /api/diet/templates
router.get('/templates', auth, async (req, res, next) => {
  try {
    const { goal } = req.query;
    const conds = ['is_active = true'];
    const params = [];
    let p = 1;

    if (goal) { conds.push(`goal = $${p++}`); params.push(goal); }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT dt.*,
        COALESCE((SELECT COUNT(*) FROM diet_plan_meals dpm WHERE dpm.diet_template_id = dt.id), 0)::int AS meal_count,
        COALESCE((SELECT json_agg(json_build_object(
          'id', dpm.id, 'meal_id', dpm.meal_id, 'name', m.name,
          'meal_type', m.meal_type, 'calories', m.calories,
          'protein_g', m.protein_g, 'carbs_g', m.carbs_g, 'fats_g', m.fats_g,
          'day_of_week', dpm.day_of_week, 'sort_order', dpm.sort_order
        ) ORDER BY dpm.day_of_week, dpm.sort_order)
        FROM diet_plan_meals dpm
        LEFT JOIN meals m ON m.id = dpm.meal_id
        WHERE dpm.diet_template_id = dt.id), '[]'::json) AS meals
      FROM diet_templates dt
      WHERE ${conds.join(' AND ')}
      ORDER BY dt.name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// POST /api/diet/templates
router.post('/templates', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.name?.trim())
      return res.status(400).json({ error: 'Template name required' });

    const id = randomUUID();
    const { rows } = await pool.query(`
      INSERT INTO diet_templates (id, name, description, goal,
        daily_calories, daily_protein_g, daily_carbs_g, daily_fats_g, created_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, d.name.trim(), d.description || null, d.goal || 'maintenance',
       parseInt(d.daily_calories) || 2000, parseFloat(d.daily_protein_g) || 0,
       parseFloat(d.daily_carbs_g) || 0, parseFloat(d.daily_fats_g) || 0, req.user.id,
       // Stamps the owning studio (migration 106). NULL only for a platform
       // operator authoring a template every studio should see.
       orgIdOf(req)]
    );

    // Link meals
    if (Array.isArray(d.meals)) {
      for (const m of d.meals) {
        await pool.query(`
          INSERT INTO diet_plan_meals (id, diet_template_id, meal_id, day_of_week, sort_order)
          VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), id, m.meal_id, parseInt(m.day_of_week) || null, parseInt(m.sort_order) || 0]
        );
      }
    }

    res.status(201).json({ message: 'Diet template created', template: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── DIET ASSIGNMENTS ────────────────────────────────────────

// GET /api/diet/assignments?client_id=&status=
router.get('/assignments', auth, async (req, res, next) => {
  try {
    const { client_id, status } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    const conds = ['da.client_id = $1'];
    const params = [client_id];
    let p = 2;
    if (status) { conds.push(`da.status = $${p++}`); params.push(status); }
    const scope = tenantScope(req);
    if (scope.applyFilter) { conds.push(`da.organization_id = $${p++}`); params.push(scope.orgId); }

    const { rows } = await pool.query(`
      SELECT da.*, dt.name AS template_name, dt.goal AS template_goal,
             dt.daily_calories, dt.daily_protein_g, dt.daily_carbs_g, dt.daily_fats_g
        FROM diet_assignments da
        JOIN diet_templates dt ON dt.id = da.diet_template_id
       WHERE ${conds.join(' AND ')}
       ORDER BY da.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// POST /api/diet/assign
router.post('/assign', auth, adminOrManager, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.diet_template_id || !d.client_id)
      return res.status(400).json({ error: 'diet_template_id and client_id required' });
    if (!await clientInOrg(req, d.client_id))
      return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(`
      INSERT INTO diet_assignments (id, diet_template_id, client_id, trainer_id,
        start_date, end_date, status, notes, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (diet_template_id, client_id, status)
      DO UPDATE SET status = 'active', start_date = EXCLUDED.start_date,
        organization_id = COALESCE(diet_assignments.organization_id, EXCLUDED.organization_id), updated_at = NOW()
      RETURNING *`,
      [randomUUID(), d.diet_template_id, d.client_id, req.user.trainer_id || null,
       d.start_date || new Date().toISOString().split('T')[0],
       d.end_date || null, 'active', d.notes || null, orgIdOf(req)]
    );
    res.status(201).json({ message: 'Diet plan assigned', assignment: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── NUTRITION LOGS ──────────────────────────────────────────

// GET /api/diet/tracker — Daily nutrition log for a client
router.get('/tracker', auth, async (req, res, next) => {
  try {
    const { client_id, date } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const logDate = date || new Date().toISOString().split('T')[0];
    const scope = tenantScope(req);
    const orgGuard = scope.applyFilter ? ' AND organization_id=$3' : '';

    const { rows } = await pool.query(
      `SELECT * FROM nutrition_logs WHERE client_id=$1 AND log_date=$2${orgGuard}`,
      scope.applyFilter ? [client_id, logDate, scope.orgId] : [client_id, logDate]
    );

    // Also return the past 7 days for the weekly view
    const { rows: history } = await pool.query(`
      SELECT * FROM nutrition_logs
      WHERE client_id=$1 AND log_date >= $2::date - 6${orgGuard}
      ORDER BY log_date DESC`,
      scope.applyFilter ? [client_id, logDate, scope.orgId] : [client_id, logDate]
    );

    res.json({
      today: rows[0] || { client_id, log_date: logDate, calories_consumed: 0, protein_g: 0, carbs_g: 0, fats_g: 0, water_glasses: 0 },
      history,
    });
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.json({ today: null, history: [] });
    }
    next(err);
  }
});

// PUT /api/diet/tracker — Upsert daily nutrition log
router.put('/tracker', auth, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.client_id)
      return res.status(400).json({ error: 'client_id required' });
    if (!await clientInOrg(req, d.client_id))
      return res.status(404).json({ error: 'Client not found' });

    const logDate = d.log_date || new Date().toISOString().split('T')[0];

    const { rows } = await pool.query(`
      INSERT INTO nutrition_logs (id, client_id, log_date, calories_consumed,
        protein_g, carbs_g, fats_g, water_glasses, notes, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (client_id, log_date) DO UPDATE SET
        calories_consumed = EXCLUDED.calories_consumed,
        protein_g = EXCLUDED.protein_g,
        carbs_g = EXCLUDED.carbs_g,
        fats_g = EXCLUDED.fats_g,
        water_glasses = EXCLUDED.water_glasses,
        notes = EXCLUDED.notes,
        organization_id = COALESCE(nutrition_logs.organization_id, EXCLUDED.organization_id),
        updated_at = NOW()
      RETURNING *`,
      [randomUUID(), d.client_id, logDate,
       parseInt(d.calories_consumed) || 0, parseFloat(d.protein_g) || 0,
       parseFloat(d.carbs_g) || 0, parseFloat(d.fats_g) || 0,
       parseInt(d.water_glasses) || 0, d.notes || null, orgIdOf(req)]
    );
    res.json({ message: 'Nutrition log updated', log: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── CLIENT FITNESS PROFILE ──────────────────────────────────

// GET /api/diet/fitness-profile/:clientId
router.get('/fitness-profile/:clientId', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const orgGuard = scope.applyFilter ? ' AND organization_id=$2' : '';
    const { rows } = await pool.query(
      `SELECT * FROM client_fitness_profiles WHERE client_id=$1${orgGuard}`,
      scope.applyFilter ? [req.params.clientId, scope.orgId] : [req.params.clientId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json(null);
    next(err);
  }
});

// PUT /api/diet/fitness-profile/:clientId
router.put('/fitness-profile/:clientId', auth, async (req, res, next) => {
  try {
    const d = req.body;
    const clientId = req.params.clientId;
    if (!await clientInOrg(req, clientId))
      return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(`
      INSERT INTO client_fitness_profiles (id, client_id, goal, goal_other,
        height_cm, body_fat_pct, health_conditions, injuries,
        emergency_contact, emergency_phone, fitness_level,
        sleep_hours, stress_level, diet_preference, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (client_id) DO UPDATE SET
        goal = EXCLUDED.goal,
        goal_other = EXCLUDED.goal_other,
        height_cm = EXCLUDED.height_cm,
        body_fat_pct = EXCLUDED.body_fat_pct,
        health_conditions = EXCLUDED.health_conditions,
        injuries = EXCLUDED.injuries,
        emergency_contact = EXCLUDED.emergency_contact,
        emergency_phone = EXCLUDED.emergency_phone,
        fitness_level = EXCLUDED.fitness_level,
        sleep_hours = EXCLUDED.sleep_hours,
        stress_level = EXCLUDED.stress_level,
        diet_preference = EXCLUDED.diet_preference,
        organization_id = COALESCE(client_fitness_profiles.organization_id, EXCLUDED.organization_id),
        updated_at = NOW()
      RETURNING *`,
      [randomUUID(), clientId, d.goal || null, d.goal_other || null,
       d.height_cm ? parseFloat(d.height_cm) : null,
       d.body_fat_pct ? parseFloat(d.body_fat_pct) : null,
       Array.isArray(d.health_conditions) ? d.health_conditions : null,
       d.injuries || null, d.emergency_contact || null, d.emergency_phone || null,
       d.fitness_level || null, d.sleep_hours ? parseFloat(d.sleep_hours) : null,
       d.stress_level || null, d.diet_preference || null, orgIdOf(req)]
    );
    res.json({ message: 'Fitness profile updated', profile: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── SUPPLEMENTS ─────────────────────────────────────────────

// GET /api/diet/supplements
router.get('/supplements', auth, async (req, res, next) => {
  try {
    // Return a standard list of supplements (could be a DB table in future)
    res.json([
      { id: '1', name: 'Whey Protein', dosage: '30g post-workout', timing: 'Post-workout', benefit: 'Muscle recovery & growth', emoji: '🥛' },
      { id: '2', name: 'Creatine Monohydrate', dosage: '5g daily', timing: 'Pre or post-workout', benefit: 'Strength & power output', emoji: '💪' },
      { id: '3', name: 'Omega-3 Fish Oil', dosage: '1000mg with meals', timing: 'With breakfast & dinner', benefit: 'Joint health & inflammation', emoji: '🐟' },
      { id: '4', name: 'Vitamin D3', dosage: '2000 IU daily', timing: 'With breakfast', benefit: 'Immune & bone health', emoji: '☀️' },
      { id: '5', name: 'BCAAs', dosage: '10g during workout', timing: 'During training', benefit: 'Reduced muscle soreness', emoji: '🧬' },
      { id: '6', name: 'Magnesium', dosage: '400mg before bed', timing: 'Before sleep', benefit: 'Better sleep & recovery', emoji: '🌙' },
    ]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
