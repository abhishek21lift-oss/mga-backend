const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');
const scoring = require('./fitness-scoring');
const goalScoring = require('./goal-scoring');
const lifestyleScoring = require('./lifestyle-scoring');
const nutritionScoring = require('./nutrition-scoring');
const mobilityScoring = require('./mobility-scoring');
const postureScoring = require('./posture-scoring');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const numOpt = () => z.coerce.number().optional().nullable();

const assessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    trainer_id: z.string().optional().nullable(),
    assessment_date: z.string().optional().nullable(),
    assessment_type: z.enum(['initial', 'week_4', 'week_8', 'week_12', 'monthly', 'quarterly', 'follow_up', 'custom']).optional(),
    assessment_notes: z.string().max(2000).optional().nullable(),
    age: numOpt(), gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),

    // Step 1 — Blood Pressure
    bp_systolic: numOpt(), bp_diastolic: numOpt(), resting_heart_rate: numOpt(), resting_spo2: numOpt(),

    // Step 2 — Anthropometric
    weight: numOpt(), height_cm: numOpt(), waist_cm: numOpt(), waist_iliac_cm: numOpt(), hips_cm: numOpt(), neck_cm: numOpt(), chest_cm: numOpt(),
    arm_right_cm: numOpt(), arm_left_cm: numOpt(), thigh_right_cm: numOpt(), thigh_left_cm: numOpt(),
    calf_right_cm: numOpt(), calf_left_cm: numOpt(),

    // Step 3 — Body Composition
    body_comp_method: z.enum(['BIA Machine', 'Skinfold', 'DEXA', 'Manual', 'Other']).optional().nullable(),
    body_fat_pct: numOpt(), muscle_mass_pct: numOpt(), visceral_fat: numOpt(), subcutaneous_fat_pct: numOpt(),
    body_water_pct: numOpt(), bone_mass_kg: numOpt(), bmr: numOpt(), bmr_auto_suggested: z.boolean().optional(),
    metabolic_age: numOpt(),

    // Step 4 — Cardiorespiratory Endurance
    cardio_test_type: z.enum(['YMCA 3-Minute Step Test', 'Rockport 1-Mile Walk', 'Cooper 12-Minute Run', 'Bruce Protocol', 'Harvard Step Test', 'Custom']).optional().nullable(),
    cardio_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 5 — Muscular Strength (two distinct tests required, same battery
    // pattern as Endurance below — any exercise can be tested, but exactly
    // two are needed to complete the step)
    strength_exercise: z.string().max(100).optional().nullable(),
    strength_exercise_2: z.string().max(100).optional().nullable(),
    strength_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 6 — Muscular Endurance (two distinct tests required)
    endurance_test_type: z.enum(['Push Up Test', 'Curl Up Test', 'Wall Sit', 'Plank', 'Bodyweight Squat', 'Custom']).optional().nullable(),
    endurance_test_type_2: z.enum(['Push Up Test', 'Curl Up Test', 'Wall Sit', 'Plank', 'Bodyweight Squat', 'Custom']).optional().nullable(),
    endurance_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 7 — Flexibility (two distinct tests required — same battery
    // pattern; flexibility_test_data now holds {test1, test2})
    flexibility_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    posture_notes: z.string().max(2000).optional().nullable(),
    health_notes: z.string().max(2000).optional().nullable(),
    trainer_notes: z.string().max(2000).optional().nullable(),
  }),
};

router.get('/assessments', auth, wrap(async (req, res) => {
  const { client_id, limit, offset } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation (Phase 1): only the caller's org's assessments.
  // Qualify with the pa alias — this query joins `trainers`, which also has an
  // organization_id column, so an unqualified reference is ambiguous.
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`pa.organization_id = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  params.push(lim); const limIdx = params.length;
  params.push(off); const offIdx = params.length;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT pa.*, t.name AS trainer_name FROM pt_assessments pa
     LEFT JOIN trainers t ON t.id = pa.trainer_id ${whereSql}
     ORDER BY assessment_date DESC LIMIT $${limIdx} OFFSET $${offIdx}`, params
  );
  res.json({ data: rows });
}));

router.post('/assessments', auth, requireRole('admin','manager','trainer'), validate(assessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const trainer_id = req.user.role === 'trainer' ? req.user.trainer_id : b.trainer_id;

  // Age/gender: prefer what the frontend sent (it already has the client
  // record loaded); fall back to a DB lookup so BMR/VO2max/norms still work
  // if the caller omits them.
  let age = b.age ?? null;
  let gender = b.gender ?? null;
  if (age == null || gender == null) {
    // Tenant scope: never read another studio's client demographics.
    const dScope = tenantScope(req);
    const cParams = [b.client_id];
    let cOrg = '';
    if (dScope.applyFilter) { cParams.push(dScope.orgId); cOrg = ' AND organization_id = $2'; }
    const { rows: cRows } = await pool.query(`SELECT dob, gender FROM pt_clients WHERE id = $1${cOrg}`, cParams);
    const c = cRows[0];
    if (c) {
      if (age == null && c.dob) {
        const dob = new Date(c.dob);
        const today = new Date();
        age = today.getFullYear() - dob.getFullYear() - (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
      }
      if (gender == null) gender = c.gender;
    }
  }

  // ── Step 1: Blood Pressure ──
  const bp = scoring.classifyBp(b.bp_systolic ?? null, b.bp_diastolic ?? null);

  // ── Step 2: Anthropometric ──
  const bmi = scoring.calcBmi(b.weight, b.height_cm);
  const waistHipRatio = scoring.calcWhr(b.waist_cm, b.hips_cm);

  // ── Step 3: Body Composition ──
  const leanBodyMass = scoring.calcLeanBodyMass(b.weight, b.body_fat_pct);
  const fatMass = scoring.calcFatMass(b.weight, b.body_fat_pct);
  let bmr = b.bmr ?? null;
  let bmrAutoSuggested = false;
  if (bmr == null) {
    bmr = scoring.calcBmr(b.weight, b.height_cm, age, gender);
    bmrAutoSuggested = bmr != null;
  }

  // ── Step 4: Cardio ── (formula depends on the selected test)
  const cd = b.cardio_test_data || {};
  let vo2Max = null;
  let cardioCategory = null;
  if (b.cardio_test_type === 'Rockport 1-Mile Walk') {
    vo2Max = scoring.calcVo2MaxRockport(b.weight, age, gender, num(cd.timeMin, null), num(cd.heartRate, null));
  } else if (b.cardio_test_type === 'Cooper 12-Minute Run') {
    vo2Max = scoring.calcVo2MaxCooper(num(cd.distanceMeters, null));
  } else if (b.cardio_test_type === 'Bruce Protocol') {
    vo2Max = scoring.calcVo2MaxBruce(num(cd.treadmillMinutes, null));
  } else if (b.cardio_test_type === 'Harvard Step Test') {
    const pei = scoring.calcHarvardPei(num(cd.durationSec, null), num(cd.pulse1, null), num(cd.pulse2, null), num(cd.pulse3, null));
    cardioCategory = scoring.classifyHarvardPei(pei);
    cd.pei = pei;
  } else if (b.cardio_test_type === 'YMCA 3-Minute Step Test') {
    cardioCategory = scoring.classifyStepTestRecovery(num(cd.recoveryHr, null));
  }
  if (vo2Max != null && !cardioCategory) cardioCategory = scoring.classifyVo2Max(vo2Max, age, gender);
  const cardioScore = scoring.scoreCategory(cardioCategory);

  // ── Step 5: Strength (two-test battery, same shape as Endurance below —
  //    any exercise may be tested, but only 2 are required to complete the
  //    step; the combined score is the average of both, same averaging
  //    scoreEnduranceBattery already does for Endurance) ──
  const sd = b.strength_test_data || {};
  const st1 = sd.test1 || {};
  const st2 = sd.test2 || {};
  const strengthFormula1 = st1.formula === 'brzycki' ? 'brzycki' : 'epley';
  const strengthFormula2 = st2.formula === 'brzycki' ? 'brzycki' : 'epley';
  const strengthOneRm1 = st1.isDirect
    ? num(st1.direct1RM, null)
    : scoring.calc1RM(num(st1.weightKg, null), num(st1.reps, null), strengthFormula1);
  const strengthOneRm2 = st2.isDirect
    ? num(st2.direct1RM, null)
    : scoring.calc1RM(num(st2.weightKg, null), num(st2.reps, null), strengthFormula2);
  const strengthCategory = scoring.classifyStrength(strengthOneRm1, b.weight ?? null, b.strength_exercise || null, gender);
  const strengthCategory2 = scoring.classifyStrength(strengthOneRm2, b.weight ?? null, b.strength_exercise_2 || null, gender);
  const strengthScore = scoring.scoreEnduranceBattery(
    scoring.scoreCategory(strengthCategory),
    scoring.scoreCategory(strengthCategory2),
  );

  // ── Step 6: Endurance (two tests, combined into one averaged score) ──
  const ed = b.endurance_test_data || {};
  const t1 = ed.test1 || {};
  const t2 = ed.test2 || {};
  const enduranceValue1 = num(t1.reps, null) ?? num(t1.durationSec, null);
  const enduranceValue2 = num(t2.reps, null) ?? num(t2.durationSec, null);
  const enduranceCategory = scoring.classifyEndurance(b.endurance_test_type, enduranceValue1, gender);
  const enduranceCategory2 = scoring.classifyEndurance(b.endurance_test_type_2, enduranceValue2, gender);
  const enduranceScore = scoring.scoreEnduranceBattery(
    scoring.scoreCategory(enduranceCategory),
    scoring.scoreCategory(enduranceCategory2),
  );

  // ── Step 7: Flexibility (two-test battery — flexibility_test_data holds
  //    {test1, test2} going forward; asymmetry flags if EITHER test shows
  //    it, and the mobility score averages both tests' categories) ──
  const fd = b.flexibility_test_data || {};
  const ft1 = fd.test1 || {};
  const ft2 = fd.test2 || {};
  const hasAsymmetry = scoring.checkAsymmetry(num(ft1.left, null), num(ft1.right, null))
    || scoring.checkAsymmetry(num(ft2.left, null), num(ft2.right, null));
  const flexibilityCategory = scoring.classifyFlexibilityScore(num(ft1.score, null));
  const flexibilityCategory2 = scoring.classifyFlexibilityScore(num(ft2.score, null));
  const mobilityScore = scoring.scoreEnduranceBattery(
    scoring.scoreCategory(flexibilityCategory),
    scoring.scoreCategory(flexibilityCategory2),
  );

  // ── Dashboard scores ──
  const bodyCompositionScore = scoring.scoreBodyComposition(b.body_fat_pct ?? null, gender);
  const healthRiskScore = scoring.scoreHealthRisk(bp.category, bmi);
  const overallScore = scoring.computeOverallScore({
    bodyComposition: bodyCompositionScore, endurance: enduranceScore,
    mobility: mobilityScore, cardio: cardioScore, healthRisk: healthRiskScore,
    strength: strengthScore,
  });

  const { rows } = await pool.query(
    `INSERT INTO pt_assessments (
       client_id, trainer_id, assessment_type, assessment_number, assessment_date,
       trainer_notes,
       bp_systolic, bp_diastolic, resting_heart_rate, resting_spo2, bp_category,
       weight, height_cm, bmi, waist_cm, waist_iliac_cm, hips_cm, waist_hip_ratio, neck_cm, chest_cm,
       arm_right_cm, arm_left_cm, thigh_right_cm, thigh_left_cm, calf_right_cm, calf_left_cm,
       body_comp_method, body_fat_pct, muscle_mass_pct, lean_body_mass_kg, fat_mass_kg,
       visceral_fat, subcutaneous_fat_pct, body_water_pct, bone_mass_kg, bmr, bmr_auto_suggested, metabolic_age,
       cardio_test_type, cardio_test_data, vo2_max, cardio_category, cardio_score_computed,
       strength_exercise, strength_exercise_2, strength_category, strength_category_2, strength_test_data, strength_score_computed,
       endurance_test_type, endurance_test_type_2, endurance_test_data, endurance_category, endurance_category_2, endurance_score_computed,
       flexibility_test_data, flexibility_category, flexibility_category_2, has_asymmetry, mobility_score_computed,
       body_composition_score, health_risk_score, overall_fitness_score,
       posture_notes, health_notes, created_by, organization_id
     ) VALUES (
       $1,$2,$3,(SELECT COUNT(*)+1 FROM pt_assessments WHERE client_id = $1),COALESCE($4, NOW()),
       $5,
       $6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,$19,
       $20,$21,$22,$23,$24,$25,
       $26,$27,$28,$29,$30,
       $31,$32,$33,$34,$35,$36,$37,
       $38,$39::jsonb,$40,$41,$42,
       $43,$44,$45,$46,$47::jsonb,$48,
       $49,$50,$51::jsonb,$52,$53,$54,
       $55::jsonb,$56,$57,$58,$59,
       $60,$61,$62,
       $63,$64,$65,$66
     ) RETURNING *`,
    [
      b.client_id, trainer_id, b.assessment_type || 'initial', b.assessment_date || null,
      b.trainer_notes || b.assessment_notes || null,
      b.bp_systolic ?? null, b.bp_diastolic ?? null, b.resting_heart_rate ?? null, b.resting_spo2 ?? null, bp.category,
      b.weight ?? null, b.height_cm ?? null, bmi, b.waist_cm ?? null, b.waist_iliac_cm ?? null, b.hips_cm ?? null, waistHipRatio, b.neck_cm ?? null, b.chest_cm ?? null,
      b.arm_right_cm ?? null, b.arm_left_cm ?? null, b.thigh_right_cm ?? null, b.thigh_left_cm ?? null, b.calf_right_cm ?? null, b.calf_left_cm ?? null,
      b.body_comp_method || null, b.body_fat_pct ?? null, b.muscle_mass_pct ?? null, leanBodyMass, fatMass,
      b.visceral_fat ?? null, b.subcutaneous_fat_pct ?? null, b.body_water_pct ?? null, b.bone_mass_kg ?? null, bmr, bmrAutoSuggested, b.metabolic_age ?? null,
      b.cardio_test_type || null, JSON.stringify(cd), vo2Max, cardioCategory, cardioScore,
      b.strength_exercise || null, b.strength_exercise_2 || null, strengthCategory, strengthCategory2, JSON.stringify(sd), strengthScore,
      b.endurance_test_type || null, b.endurance_test_type_2 || null, JSON.stringify(ed), enduranceCategory, enduranceCategory2, enduranceScore,
      JSON.stringify(fd), flexibilityCategory, flexibilityCategory2, hasAsymmetry, mobilityScore,
      bodyCompositionScore, healthRiskScore, overallScore,
      b.posture_notes || null, b.health_notes || null, req.user.id,
      orgIdOf(req),
    ]
  );
  res.status(201).json({ data: { ...rows[0], bp_unsafe: bp.isUnsafe } });
}));

const GOAL_TYPES = [
  'fat_loss', 'muscle_gain', 'body_recomposition', 'strength_gain', 'powerlifting',
  'endurance', 'general_fitness', 'mobility', 'marathon_prep', 'wedding_transformation',
  'medical_fitness', 'senior_fitness', 'athletic_performance', 'custom',
];

const goalCreateSchema = {
  body: z.object({
    client_id: z.string(),
    goal_type: z.enum(GOAL_TYPES),
    goal_other: z.string().max(200).optional().nullable(),
    goal_description: z.string().max(2000).optional().nullable(),
    target_weight: numOpt(), target_body_fat: numOpt(),
    target_date: z.string().optional().nullable(),
    priority_goal: z.string().max(50).optional().nullable(),
    motivation_reason: z.string().max(2000).optional().nullable(),
    motivation_level: numOpt(), commitment_level: numOpt(),
    biggest_challenges: z.array(z.string()).optional().nullable(),
    lifestyle_readiness: z.record(z.string(), z.boolean()).optional().nullable(),
    starting_weight: numOpt(), starting_body_fat_pct: numOpt(),
    notes: z.string().max(2000).optional().nullable(),
  }),
};

// Shared by POST (create) and PATCH (update) so the Smart Goal Analysis
// columns never drift out of sync between the two write paths.
function computeGoalAnalysis({ startingWeight, targetWeight, targetDate, lifestyleReadiness, motivationLevel, commitmentLevel }) {
  const daysRemaining = targetDate ? Math.ceil((new Date(targetDate).getTime() - Date.now()) / 86400000) : null;
  const direction = goalScoring.goalDirection(startingWeight, targetWeight);
  const requiredRate = goalScoring.calcRequiredWeeklyRate(startingWeight, targetWeight, daysRemaining);
  const safeRate = goalScoring.calcSafeWeeklyRate(startingWeight, direction);
  const lifestyleScore = goalScoring.calcLifestyleReadinessScore(lifestyleReadiness || null);
  const difficulty = goalScoring.classifyGoalDifficulty(requiredRate, safeRate, lifestyleScore, motivationLevel, commitmentLevel);
  const estimatedWeeks = goalScoring.calcEstimatedDurationWeeks(startingWeight, targetWeight, safeRate);
  const recommendedMonths = goalScoring.recommendPtDurationMonths(estimatedWeeks);
  const riskFactors = goalScoring.buildRiskFactors({
    requiredRate, safeRate, lifestyleReadinessScore: lifestyleScore,
    medicalRestrictions: lifestyleReadiness ? lifestyleReadiness.medical_restrictions === true : null,
    daysRemaining, motivationLevel, commitmentLevel,
  });
  return { lifestyleScore, difficulty, estimatedWeeks, recommendedMonths, requiredRate, safeRate, riskFactors };
}

router.get('/goals', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_goals ${whereSql} ORDER BY is_active DESC, created_at DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/goals', auth, validate(goalCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Starting weight/body-fat: prefer client-submitted (manual entry when no
  // assessment exists yet), else snapshot the client's latest assessment.
  let startingWeight = b.starting_weight ?? null;
  let startingBodyFat = b.starting_body_fat_pct ?? null;
  if (startingWeight == null || startingBodyFat == null) {
    const { rows: aRows } = await pool.query(
      'SELECT weight, body_fat_pct FROM pt_assessments WHERE client_id = $1 ORDER BY assessment_date DESC LIMIT 1',
      [b.client_id]
    );
    const latest = aRows[0];
    if (latest) {
      if (startingWeight == null && latest.weight != null) startingWeight = parseFloat(latest.weight);
      if (startingBodyFat == null && latest.body_fat_pct != null) startingBodyFat = parseFloat(latest.body_fat_pct);
    }
  }

  const analysis = computeGoalAnalysis({
    startingWeight, targetWeight: b.target_weight ?? null, targetDate: b.target_date || null,
    lifestyleReadiness: b.lifestyle_readiness || null, motivationLevel: b.motivation_level ?? null, commitmentLevel: b.commitment_level ?? null,
  });

  const { rows } = await pool.query(
    `INSERT INTO pt_goals (
       client_id, goal_type, goal_other, goal_description, target_weight, target_body_fat, target_date, notes,
       motivation_reason, priority_goal, motivation_level, commitment_level, biggest_challenges,
       lifestyle_readiness, lifestyle_readiness_score,
       starting_weight, starting_body_fat_pct,
       goal_difficulty, estimated_duration_weeks, recommended_pt_duration_months,
       estimated_weekly_rate_kg, safe_weekly_rate_kg, risk_factors,
       created_by, organization_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,
       $14::jsonb,$15,
       $16,$17,
       $18,$19,$20,
       $21,$22,$23,
       $24,$25
     ) RETURNING *`,
    [
      b.client_id, b.goal_type, b.goal_other || null, b.goal_description || null,
      b.target_weight ?? null, b.target_body_fat ?? null, b.target_date || null, b.notes || null,
      b.motivation_reason || null, b.priority_goal || null, b.motivation_level ?? null, b.commitment_level ?? null,
      b.biggest_challenges && b.biggest_challenges.length ? b.biggest_challenges : null,
      b.lifestyle_readiness ? JSON.stringify(b.lifestyle_readiness) : null, analysis.lifestyleScore,
      startingWeight, startingBodyFat,
      analysis.difficulty, analysis.estimatedWeeks, analysis.recommendedMonths,
      analysis.requiredRate, analysis.safeRate, analysis.riskFactors.length ? analysis.riskFactors : null,
      req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/goals/:id', auth, wrap(async (req, res) => {
  const allowed = [
    'goal_type', 'goal_other', 'goal_description', 'target_weight', 'target_body_fat', 'target_date', 'notes', 'is_active',
    'motivation_reason', 'priority_goal', 'motivation_level', 'commitment_level', 'biggest_challenges',
    'lifestyle_readiness', 'starting_weight', 'starting_body_fat_pct',
  ];

  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_goals WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = key === 'lifestyle_readiness' && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computeGoalAnalysis({
    startingWeight: merged.starting_weight != null ? parseFloat(merged.starting_weight) : null,
    targetWeight: merged.target_weight != null ? parseFloat(merged.target_weight) : null,
    targetDate: merged.target_date || null,
    lifestyleReadiness: merged.lifestyle_readiness || null,
    motivationLevel: merged.motivation_level != null ? parseInt(merged.motivation_level, 10) : null,
    commitmentLevel: merged.commitment_level != null ? parseInt(merged.commitment_level, 10) : null,
  });

  for (const [col, val] of Object.entries({
    lifestyle_readiness_score: analysis.lifestyleScore,
    goal_difficulty: analysis.difficulty,
    estimated_duration_weeks: analysis.estimatedWeeks,
    recommended_pt_duration_months: analysis.recommendedMonths,
    estimated_weekly_rate_kg: analysis.requiredRate,
    safe_weekly_rate_kg: analysis.safeRate,
    risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_goals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

router.get('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 52);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM weekly_checkins ${whereSql} ORDER BY week_start_date DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

router.post('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, week_start_date, weight, mood, sleep_hours, water_glasses, workout_count, calories_avg, adherence_pct, trainer_notes, client_notes, stress_level, energy_level, soreness_level } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Stress, energy and soreness are the three readings the readiness score
  // needs, and all three are optional — a thirty-second check-in at the door
  // should record what the client said and leave the rest blank. Out-of-scale
  // values are stored as NULL rather than rejected: a mistyped 75 must not
  // fail the whole check-in, and it must not drag the score either. The column
  // CHECKs are the backstop; this is the polite version.
  const scale10 = (v) => {
    const n = num(v, null);
    return n !== null && n >= 1 && n <= 10 ? Math.round(n) : null;
  };

  const { rows } = await pool.query(
    `INSERT INTO weekly_checkins (client_id, week_start_date, weight, mood, sleep_hours, water_glasses,
      workout_count, calories_avg, adherence_pct, trainer_notes, client_notes, created_by, organization_id,
      stress_level, energy_level, soreness_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (client_id, week_start_date) DO UPDATE SET
       weight = EXCLUDED.weight, mood = EXCLUDED.mood, sleep_hours = EXCLUDED.sleep_hours,
       water_glasses = EXCLUDED.water_glasses, workout_count = EXCLUDED.workout_count,
       calories_avg = EXCLUDED.calories_avg, adherence_pct = EXCLUDED.adherence_pct,
       trainer_notes = EXCLUDED.trainer_notes, client_notes = EXCLUDED.client_notes,
       stress_level = EXCLUDED.stress_level, energy_level = EXCLUDED.energy_level,
       soreness_level = EXCLUDED.soreness_level,
       updated_at = NOW()
     RETURNING *`,
    [client_id, week_start_date, num(weight, null), mood || null, num(sleep_hours, null),
     num(water_glasses, null), num(workout_count, 0), num(calories_avg, null),
     num(adherence_pct, null), trainer_notes || null, client_notes || null, req.user.id, orgIdOf(req),
     scale10(stress_level), scale10(energy_level), scale10(soreness_level)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.get('/strength-logs', auth, wrap(async (req, res) => {
  const { client_id, exercise_name, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  if (exercise_name) { params.push(exercise_name); where.push(`exercise_name = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM strength_logs ${whereSql} ORDER BY log_date DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

const strengthLogCreateSchema = {
  body: z.object({
    client_id: z.string(),
    exercise_name: z.string().min(1).max(100),
    weight_kg: z.coerce.number(),
    sets_done: numOpt(), reps_done: numOpt(),
    notes: z.string().max(1000).optional().nullable(),
    assessment_id: z.string().optional().nullable(),
    one_rm_formula: z.enum(['epley', 'brzycki']).optional(),
    is_direct_1rm: z.boolean().optional(),
    one_rm_estimate: numOpt(),
  }),
};

router.post('/strength-logs', auth, requireRole('admin', 'manager', 'trainer'), validate(strengthLogCreateSchema), wrap(async (req, res) => {
  const { client_id, exercise_name, weight_kg, sets_done, reps_done, notes,
    assessment_id, one_rm_formula, is_direct_1rm, one_rm_estimate } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const formula = one_rm_formula === 'brzycki' ? 'brzycki' : 'epley';
  const oneRm = is_direct_1rm
    ? num(one_rm_estimate, null)
    : scoring.calc1RM(num(weight_kg), num(reps_done, 10), formula);
  const { rows } = await pool.query(
    `INSERT INTO strength_logs (client_id, exercise_name, weight_kg, sets_done, reps_done, one_rm_estimate, notes, assessment_id, one_rm_formula, is_direct_1rm, organization_id)
     VALUES ($1,$2,$3,$4,$5,ROUND($6::NUMERIC,2),$7,$8,$9,$10,$11) RETURNING *`,
    [client_id, exercise_name, num(weight_kg), num(sets_done, 3), num(reps_done, 10), oneRm, notes || null,
     assessment_id || null, formula, Boolean(is_direct_1rm), orgIdOf(req)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.get('/progress-photos', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM progress_photos ${whereSql} ORDER BY taken_at DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

const progressPhotoCreateSchema = {
  body: z.object({
    client_id: z.string(),
    photo_url: z.string().min(1),
    photo_type: z.enum(['front', 'side', 'back', 'flexed', 'full_body', 'other']).optional(),
    taken_at: z.string().optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  }),
};

router.post('/progress-photos', auth, requireRole('admin', 'manager', 'trainer'), validate(progressPhotoCreateSchema), wrap(async (req, res) => {
  const { client_id, photo_url, photo_type, taken_at, notes } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(
    `INSERT INTO progress_photos (client_id, photo_url, photo_type, taken_at, notes, uploaded_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [client_id, photo_url, photo_type || 'front', taken_at || new Date().toISOString().split('T')[0],
     notes || null, req.user.id, orgIdOf(req)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.delete('/progress-photos/:id', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  if (scope.applyFilter) {
    await pool.query('DELETE FROM progress_photos WHERE id = $1 AND organization_id = $2', [req.params.id, scope.orgId]);
  } else {
    await pool.query('DELETE FROM progress_photos WHERE id = $1', [req.params.id]);
  }
  res.status(204).end();
}));

const LIFESTYLE_OCCUPATION_TYPES = [
  'desk_job', 'active_job', 'physical_labor', 'student', 'homemaker',
  'driver', 'healthcare', 'police', 'fitness_professional', 'retired', 'other',
];

const lifestyleAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: z.string().optional().nullable(),

    sleep_duration_hours: numOpt(), bed_time: z.string().optional().nullable(), wake_time: z.string().optional().nullable(),
    sleep_quality: numOpt(),

    stress_level: numOpt(),

    water_intake_liters: numOpt(),

    occupation_type: z.enum(LIFESTYLE_OCCUPATION_TYPES).optional().nullable(),
    daily_steps_bracket: z.enum(['<3000', '3000_5000', '5000_8000', '8000_10000', '10000_plus']).optional().nullable(),

    workout_experience_level: z.enum(['beginner', 'intermediate', 'advanced', 'athlete']).optional().nullable(),
    years_of_experience: numOpt(),

    food_preferences: z.array(z.string()).optional().nullable(),

    meal_frequency: numOpt(),
    breakfast_habit: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    late_night_eating: z.boolean().optional().nullable(),

    smoking_status: z.enum(['never', 'occasionally', 'daily', 'former']).optional().nullable(),
    cigarettes_per_day: numOpt(), years_smoking: numOpt(),
    alcohol_status: z.enum(['never', 'occasionally', 'weekly', 'frequently']).optional().nullable(),
    drinks_per_week: numOpt(),

    screen_time_bracket: z.enum(['<2', '2_4', '4_6', '6_8', '8_plus']).optional().nullable(),
    travel_frequency: z.enum(['rarely', 'monthly', 'weekly', 'daily']).optional().nullable(),
    energy_level: numOpt(), motivation_to_exercise: numOpt(),
    recovery_quality: z.enum(['poor', 'average', 'good', 'excellent']).optional().nullable(),

    coach_notes: z.record(z.string(), z.string()).optional().nullable(),
  }),
};

// Shared by POST (create) and PATCH (update) so the Smart Lifestyle
// Analysis columns never drift out of sync between the two write paths.
function computeLifestyleAnalysis(b) {
  const sleep = lifestyleScoring.classifySleep(b.sleep_duration_hours ?? null, b.sleep_quality ?? null);
  const stressScore = lifestyleScoring.calcStressScore(b.stress_level ?? null);
  const hydration = lifestyleScoring.classifyHydration(b.water_intake_liters ?? null);
  const activity = lifestyleScoring.classifyActivity(b.daily_steps_bracket || null, b.occupation_type || null);
  const nutritionScore = lifestyleScoring.calcNutritionScore(b.meal_frequency ?? null, b.breakfast_habit || null, b.late_night_eating ?? null);
  const recoveryScore = lifestyleScoring.calcRecoveryScore(sleep.score, stressScore, b.energy_level ?? null, b.recovery_quality || null);
  const sedentaryRisk = lifestyleScoring.classifyRisk(activity.score);
  const recoveryRisk = lifestyleScoring.classifyRisk(recoveryScore);

  const habitInputs = {
    smokingStatus: b.smoking_status || null, alcoholStatus: b.alcohol_status || null,
    sleepScore: sleep.score, stressScore, hydrationScore: hydration.score, activityScore: activity.score, nutritionScore,
  };
  const habitRiskScore = lifestyleScoring.calcHabitRiskScore(habitInputs);
  const riskFactors = lifestyleScoring.buildLifestyleRiskFactors(habitInputs);

  const lifestyleScoreVal = lifestyleScoring.calcLifestyleScore(
    { sleep: sleep.score, stress: stressScore, hydration: hydration.score, activity: activity.score, nutrition: nutritionScore, recovery: recoveryScore },
    habitRiskScore
  );
  const lifestyleReadiness = lifestyleScoring.classifyLifestyleReadiness(lifestyleScoreVal);

  return {
    sleepCategory: sleep.category, sleepScore: sleep.score,
    stressScore,
    hydrationCategory: hydration.category, hydrationScore: hydration.score,
    activityLevel: activity.level, activityScore: activity.score,
    nutritionScore,
    recoveryScore,
    sedentaryRisk, recoveryRisk,
    habitRiskScore, riskFactors,
    lifestyleScore: lifestyleScoreVal, lifestyleReadiness,
  };
}

router.get('/lifestyle-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_lifestyle_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/lifestyle-assessments', auth, requireRole('admin', 'manager', 'trainer'), validate(lifestyleAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computeLifestyleAnalysis(b);

  const { rows } = await pool.query(
    `INSERT INTO pt_lifestyle_assessments (
       client_id, assessment_number, assessment_date,
       sleep_duration_hours, bed_time, wake_time, sleep_quality, sleep_category, sleep_score,
       stress_level, stress_score,
       water_intake_liters, hydration_category, hydration_score,
       occupation_type, daily_steps_bracket, activity_level, activity_score,
       workout_experience_level, years_of_experience,
       food_preferences,
       meal_frequency, breakfast_habit, late_night_eating, nutrition_score,
       smoking_status, cigarettes_per_day, years_smoking, alcohol_status, drinks_per_week,
       screen_time_bracket, travel_frequency, energy_level, motivation_to_exercise, recovery_quality, recovery_score,
       sedentary_risk, recovery_risk, habit_risk_score, risk_factors, lifestyle_score, lifestyle_readiness,
       coach_notes, created_by
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_lifestyle_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,$4,$5,$6,$7,$8,
       $9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,
       $20,
       $21,$22,$23,$24,
       $25,$26,$27,$28,$29,
       $30,$31,$32,$33,$34,$35,
       $36,$37,$38,$39,$40,$41,
       $42::jsonb,$43
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || null,
      b.sleep_duration_hours ?? null, b.bed_time || null, b.wake_time || null, b.sleep_quality ?? null, analysis.sleepCategory, analysis.sleepScore,
      b.stress_level ?? null, analysis.stressScore,
      b.water_intake_liters ?? null, analysis.hydrationCategory, analysis.hydrationScore,
      b.occupation_type || null, b.daily_steps_bracket || null, analysis.activityLevel, analysis.activityScore,
      b.workout_experience_level || null, b.years_of_experience ?? null,
      b.food_preferences && b.food_preferences.length ? b.food_preferences : null,
      b.meal_frequency ?? null, b.breakfast_habit || null, b.late_night_eating ?? null, analysis.nutritionScore,
      b.smoking_status || null, b.cigarettes_per_day ?? null, b.years_smoking ?? null, b.alcohol_status || null, b.drinks_per_week ?? null,
      b.screen_time_bracket || null, b.travel_frequency || null, b.energy_level ?? null, b.motivation_to_exercise ?? null, b.recovery_quality || null, analysis.recoveryScore,
      analysis.sedentaryRisk, analysis.recoveryRisk, analysis.habitRiskScore, analysis.riskFactors.length ? analysis.riskFactors : null, analysis.lifestyleScore, analysis.lifestyleReadiness,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id,
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/lifestyle-assessments/:id', auth, wrap(async (req, res) => {
  const allowed = [
    'assessment_date', 'sleep_duration_hours', 'bed_time', 'wake_time', 'sleep_quality', 'stress_level',
    'water_intake_liters', 'occupation_type', 'daily_steps_bracket', 'workout_experience_level', 'years_of_experience',
    'food_preferences', 'meal_frequency', 'breakfast_habit', 'late_night_eating',
    'smoking_status', 'cigarettes_per_day', 'years_smoking', 'alcohol_status', 'drinks_per_week',
    'screen_time_bracket', 'travel_frequency', 'energy_level', 'motivation_to_exercise', 'recovery_quality', 'coach_notes',
  ];

  const { rows: existingRows } = await pool.query('SELECT * FROM pt_lifestyle_assessments WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = key === 'coach_notes' && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computeLifestyleAnalysis({
    sleep_duration_hours: merged.sleep_duration_hours != null ? parseFloat(merged.sleep_duration_hours) : null,
    sleep_quality: merged.sleep_quality != null ? parseInt(merged.sleep_quality, 10) : null,
    stress_level: merged.stress_level != null ? parseInt(merged.stress_level, 10) : null,
    water_intake_liters: merged.water_intake_liters != null ? parseFloat(merged.water_intake_liters) : null,
    occupation_type: merged.occupation_type || null,
    daily_steps_bracket: merged.daily_steps_bracket || null,
    meal_frequency: merged.meal_frequency != null ? parseInt(merged.meal_frequency, 10) : null,
    breakfast_habit: merged.breakfast_habit || null,
    late_night_eating: merged.late_night_eating,
    energy_level: merged.energy_level != null ? parseInt(merged.energy_level, 10) : null,
    recovery_quality: merged.recovery_quality || null,
    smoking_status: merged.smoking_status || null,
    alcohol_status: merged.alcohol_status || null,
  });

  for (const [col, val] of Object.entries({
    sleep_category: analysis.sleepCategory, sleep_score: analysis.sleepScore,
    stress_score: analysis.stressScore,
    hydration_category: analysis.hydrationCategory, hydration_score: analysis.hydrationScore,
    activity_level: analysis.activityLevel, activity_score: analysis.activityScore,
    nutrition_score: analysis.nutritionScore,
    recovery_score: analysis.recoveryScore,
    sedentary_risk: analysis.sedentaryRisk, recovery_risk: analysis.recoveryRisk,
    habit_risk_score: analysis.habitRiskScore, risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
    lifestyle_score: analysis.lifestyleScore, lifestyle_readiness: analysis.lifestyleReadiness,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_lifestyle_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

const nutritionSupplementSchema = z.object({
  name: z.string(), dose: z.string().optional().nullable(),
  frequency: z.string().optional().nullable(), brand: z.string().optional().nullable(),
});
const nutritionDigestiveIssueSchema = z.object({
  issue: z.string(), frequency: z.enum(['daily', 'weekly', 'rare']).optional().nullable(),
  severity: numOpt(),
});

const nutritionAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: z.string().optional().nullable(),

    diet_preferences: z.array(z.string()).optional().nullable(),

    food_allergies: z.array(z.string()).optional().nullable(),
    foods_to_avoid: z.array(z.string()).optional().nullable(),
    foods_to_avoid_reason: z.enum(['medical', 'religious', 'personal_preference', 'taste', 'digestive_issue']).optional().nullable(),

    favourite_foods: z.array(z.string()).optional().nullable(),

    takes_supplements: z.boolean().optional().nullable(),
    supplements: z.array(nutritionSupplementSchema).optional().nullable(),

    digestive_issues: z.array(nutritionDigestiveIssueSchema).optional().nullable(),

    meals_per_day: numOpt(),
    breakfast_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    lunch_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    dinner_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    snacks_per_day: numOpt(),
    late_night_eating: z.boolean().optional().nullable(),
    meal_timing_consistency: z.enum(['consistent', 'somewhat_consistent', 'inconsistent']).optional().nullable(),
    eating_out_frequency: z.enum(['rarely', 'weekly', 'frequently', 'daily']).optional().nullable(),
    weekend_eating_habits: z.enum(['similar_to_weekday', 'somewhat_different', 'very_different_indulgent']).optional().nullable(),
    eating_behaviours: z.array(z.string()).optional().nullable(),

    water_intake_liters: numOpt(),
    tea_cups_per_day: numOpt(), coffee_cups_per_day: numOpt(), soft_drinks_per_day: numOpt(), juices_per_day: numOpt(),
    alcoholic_drinks_per_week: numOpt(),
    cravings: z.array(z.string()).optional().nullable(),
    craving_frequency: z.enum(['rare', 'sometimes', 'daily']).optional().nullable(),

    meal_preparer: z.enum(['self', 'family', 'cook', 'restaurant', 'food_delivery', 'mess', 'hostel', 'office_cafeteria']).optional().nullable(),
    nutrition_budget: z.enum(['low', 'medium', 'high', 'premium']).optional().nullable(),
    medical_conditions: z.array(z.string()).optional().nullable(),
    medical_notes: z.string().optional().nullable(),

    coach_notes: z.record(z.string(), z.string()).optional().nullable(),
  }),
};

// Shared by POST (create) and PATCH (update) so the Smart Nutrition
// Analysis columns never drift out of sync between the two write paths.
// Reads the client's latest Lifestyle Assessment (if any) for the
// smoking/alcohol risk inputs — a plain read of an existing table, no
// hard dependency: the two risk factors simply don't fire without it.
async function computeNutritionAnalysis(clientId, b) {
  const { rows: lifestyleRows } = await pool.query(
    'SELECT smoking_status, alcohol_status FROM pt_lifestyle_assessments WHERE client_id = $1 ORDER BY assessment_date DESC LIMIT 1',
    [clientId]
  );
  const lifestyle = lifestyleRows[0] || {};

  const dietQualityScore = nutritionScoring.calcDietQualityScore(
    b.foods_to_avoid ?? null, b.favourite_foods ?? null, b.cravings ?? null,
    b.craving_frequency ?? null, b.eating_behaviours ?? null, b.breakfast_regularity ?? null, b.late_night_eating ?? null
  );
  const protein = nutritionScoring.assessProtein(b.favourite_foods ?? null, b.takes_supplements ?? null, b.supplements ?? null);
  const dailyFluidIntake = nutritionScoring.calcDailyFluidIntake(
    b.water_intake_liters ?? null, b.tea_cups_per_day ?? null, b.coffee_cups_per_day ?? null, b.soft_drinks_per_day ?? null, b.juices_per_day ?? null
  );
  const hydrationScore = nutritionScoring.calcHydrationScore(b.water_intake_liters ?? null, b.soft_drinks_per_day ?? null, b.alcoholic_drinks_per_week ?? null);
  const digestiveHealthScore = nutritionScoring.calcDigestiveHealthScore(b.digestive_issues ?? null);
  const supplementScore = nutritionScoring.calcSupplementScore(b.takes_supplements ?? null, b.supplements ?? null);

  const riskInputs = {
    proteinAssessment: protein.assessment, hydrationScore, digestiveHealthScore,
    cravings: b.cravings ?? null, cravingFrequency: b.craving_frequency ?? null,
    medicalConditions: b.medical_conditions ?? null, medicalNotes: b.medical_notes ?? null,
    alcoholStatus: lifestyle.alcohol_status || null, smokingStatus: lifestyle.smoking_status || null,
  };
  const nutritionRiskScore = nutritionScoring.calcNutritionRiskScore(riskInputs);
  const riskFactors = nutritionScoring.buildNutritionRiskFactors(riskInputs);

  const nutritionScoreVal = nutritionScoring.calcNutritionScore(
    { dietQuality: dietQualityScore, protein: protein.score, hydration: hydrationScore, digestive: digestiveHealthScore, supplement: supplementScore },
    nutritionRiskScore
  );
  const nutritionReadiness = nutritionScoring.classifyNutritionReadiness(nutritionScoreVal);

  return {
    dietQualityScore,
    proteinScore: protein.score, proteinAssessment: protein.assessment,
    dailyFluidIntake,
    hydrationScore,
    digestiveHealthScore,
    supplementScore,
    nutritionRiskScore, riskFactors,
    nutritionScore: nutritionScoreVal, nutritionReadiness,
  };
}

router.get('/nutrition-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_nutrition_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/nutrition-assessments', auth, requireRole('admin', 'manager', 'trainer'), validate(nutritionAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = await computeNutritionAnalysis(b.client_id, b);

  const { rows } = await pool.query(
    `INSERT INTO pt_nutrition_assessments (
       client_id, assessment_number, assessment_date,
       diet_preferences,
       food_allergies, foods_to_avoid, foods_to_avoid_reason,
       favourite_foods,
       takes_supplements, supplements,
       digestive_issues,
       meals_per_day, breakfast_regularity, lunch_regularity, dinner_regularity, snacks_per_day,
       late_night_eating, meal_timing_consistency, eating_out_frequency, weekend_eating_habits, eating_behaviours,
       water_intake_liters, tea_cups_per_day, coffee_cups_per_day, soft_drinks_per_day, juices_per_day,
       alcoholic_drinks_per_week, daily_fluid_intake_liters, cravings, craving_frequency,
       meal_preparer, nutrition_budget, medical_conditions, medical_notes,
       diet_quality_score, protein_score, protein_assessment, hydration_score, digestive_health_score,
       supplement_score, nutrition_risk_score, risk_factors, nutrition_score, nutrition_readiness,
       coach_notes, created_by
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_nutrition_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,
       $4,$5,$6,
       $7,
       $8,$9::jsonb,
       $10::jsonb,
       $11,$12,$13,$14,$15,
       $16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,
       $26,$27,$28,$29,
       $30,$31,$32,$33,
       $34,$35,$36,$37,$38,
       $39,$40,$41,$42,$43,
       $44::jsonb,$45
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || null,
      b.diet_preferences && b.diet_preferences.length ? b.diet_preferences : null,
      b.food_allergies && b.food_allergies.length ? b.food_allergies : null,
      b.foods_to_avoid && b.foods_to_avoid.length ? b.foods_to_avoid : null,
      b.foods_to_avoid_reason || null,
      b.favourite_foods && b.favourite_foods.length ? b.favourite_foods : null,
      b.takes_supplements ?? null, b.supplements ? JSON.stringify(b.supplements) : null,
      b.digestive_issues ? JSON.stringify(b.digestive_issues) : null,
      b.meals_per_day ?? null, b.breakfast_regularity || null, b.lunch_regularity || null, b.dinner_regularity || null, b.snacks_per_day ?? null,
      b.late_night_eating ?? null, b.meal_timing_consistency || null, b.eating_out_frequency || null, b.weekend_eating_habits || null,
      b.eating_behaviours && b.eating_behaviours.length ? b.eating_behaviours : null,
      b.water_intake_liters ?? null, b.tea_cups_per_day ?? null, b.coffee_cups_per_day ?? null, b.soft_drinks_per_day ?? null, b.juices_per_day ?? null,
      b.alcoholic_drinks_per_week ?? null, analysis.dailyFluidIntake, b.cravings && b.cravings.length ? b.cravings : null, b.craving_frequency || null,
      b.meal_preparer || null, b.nutrition_budget || null, b.medical_conditions && b.medical_conditions.length ? b.medical_conditions : null, b.medical_notes || null,
      analysis.dietQualityScore, analysis.proteinScore, analysis.proteinAssessment, analysis.hydrationScore, analysis.digestiveHealthScore,
      analysis.supplementScore, analysis.nutritionRiskScore, analysis.riskFactors.length ? analysis.riskFactors : null, analysis.nutritionScore, analysis.nutritionReadiness,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id,
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/nutrition-assessments/:id', auth, wrap(async (req, res) => {
  const allowed = [
    'assessment_date',
    'diet_preferences',
    'food_allergies', 'foods_to_avoid', 'foods_to_avoid_reason',
    'favourite_foods',
    'takes_supplements', 'supplements',
    'digestive_issues',
    'meals_per_day', 'breakfast_regularity', 'lunch_regularity', 'dinner_regularity', 'snacks_per_day',
    'late_night_eating', 'meal_timing_consistency', 'eating_out_frequency', 'weekend_eating_habits', 'eating_behaviours',
    'water_intake_liters', 'tea_cups_per_day', 'coffee_cups_per_day', 'soft_drinks_per_day', 'juices_per_day',
    'alcoholic_drinks_per_week', 'cravings', 'craving_frequency',
    'meal_preparer', 'nutrition_budget', 'medical_conditions', 'medical_notes', 'coach_notes',
  ];

  const { rows: existingRows } = await pool.query('SELECT * FROM pt_nutrition_assessments WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = (key === 'coach_notes' || key === 'supplements' || key === 'digestive_issues') && req.body[key] != null
        ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = await computeNutritionAnalysis(existing.client_id, {
    foods_to_avoid: merged.foods_to_avoid, favourite_foods: merged.favourite_foods,
    cravings: merged.cravings, craving_frequency: merged.craving_frequency,
    eating_behaviours: merged.eating_behaviours, breakfast_regularity: merged.breakfast_regularity,
    late_night_eating: merged.late_night_eating,
    takes_supplements: merged.takes_supplements, supplements: merged.supplements,
    water_intake_liters: merged.water_intake_liters != null ? parseFloat(merged.water_intake_liters) : null,
    tea_cups_per_day: merged.tea_cups_per_day != null ? parseInt(merged.tea_cups_per_day, 10) : null,
    coffee_cups_per_day: merged.coffee_cups_per_day != null ? parseInt(merged.coffee_cups_per_day, 10) : null,
    soft_drinks_per_day: merged.soft_drinks_per_day != null ? parseInt(merged.soft_drinks_per_day, 10) : null,
    juices_per_day: merged.juices_per_day != null ? parseInt(merged.juices_per_day, 10) : null,
    alcoholic_drinks_per_week: merged.alcoholic_drinks_per_week != null ? parseInt(merged.alcoholic_drinks_per_week, 10) : null,
    digestive_issues: merged.digestive_issues,
    medical_conditions: merged.medical_conditions, medical_notes: merged.medical_notes,
  });

  for (const [col, val] of Object.entries({
    diet_quality_score: analysis.dietQualityScore,
    protein_score: analysis.proteinScore, protein_assessment: analysis.proteinAssessment,
    daily_fluid_intake_liters: analysis.dailyFluidIntake,
    hydration_score: analysis.hydrationScore,
    digestive_health_score: analysis.digestiveHealthScore,
    supplement_score: analysis.supplementScore,
    nutrition_risk_score: analysis.nutritionRiskScore, risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
    nutrition_score: analysis.nutritionScore, nutrition_readiness: analysis.nutritionReadiness,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_nutrition_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

const bodyRegionSchema = z.object({
  region: z.string(), score: numOpt(), pain: z.boolean().optional().nullable(), restriction: z.boolean().optional().nullable(),
});
const mobilityTestSchema = z.object({
  test: z.string(), score: numOpt(), notes: z.string().optional().nullable(),
  pain: z.boolean().optional().nullable(), restriction: z.boolean().optional().nullable(),
});

const mobilityPerformanceAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: z.string().optional().nullable(),

    body_regions: z.array(bodyRegionSchema).optional().nullable(),
    mobility_tests: z.array(mobilityTestSchema).optional().nullable(),

    grip_strength_kg: numOpt(), vertical_jump_cm: numOpt(), sit_reach_cm: numOpt(),
    balance_test_seconds: numOpt(), reaction_time_ms: numOpt(),
    performance_notes: z.string().max(2000).optional().nullable(),
  }),
};

function computeMobilityAnalysis(b) {
  const mobilityScore = mobilityScoring.calcMobilityScore(b.body_regions ?? null, b.mobility_tests ?? null);
  const mobilityCategory = mobilityScoring.classifyMobility(mobilityScore);
  return { mobilityScore, mobilityCategory };
}

router.get('/mobility-performance-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation: this table missed the 084 sweep (weekly_checkins/
  // strength_logs/progress_photos) — client_id alone let a caller who knows or
  // guesses another org's client_id list that org's mobility records.
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_mobility_performance_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/mobility-performance-assessments', auth, requireRole('admin', 'manager', 'trainer'), validate(mobilityPerformanceAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computeMobilityAnalysis(b);

  const { rows } = await pool.query(
    `INSERT INTO pt_mobility_performance_assessments (
       client_id, assessment_number, assessment_date,
       body_regions, mobility_tests,
       grip_strength_kg, vertical_jump_cm, sit_reach_cm, balance_test_seconds, reaction_time_ms, performance_notes,
       mobility_score, mobility_category, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_mobility_performance_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3::jsonb,$4::jsonb,
       $5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || null,
      b.body_regions ? JSON.stringify(b.body_regions) : null, b.mobility_tests ? JSON.stringify(b.mobility_tests) : null,
      b.grip_strength_kg ?? null, b.vertical_jump_cm ?? null, b.sit_reach_cm ?? null, b.balance_test_seconds ?? null, b.reaction_time_ms ?? null, b.performance_notes || null,
      analysis.mobilityScore, analysis.mobilityCategory, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/mobility-performance-assessments/:id', auth, wrap(async (req, res) => {
  const allowed = [
    'assessment_date', 'body_regions', 'mobility_tests',
    'grip_strength_kg', 'vertical_jump_cm', 'sit_reach_cm', 'balance_test_seconds', 'reaction_time_ms', 'performance_notes',
  ];

  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_mobility_performance_assessments WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = (key === 'body_regions' || key === 'mobility_tests') && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computeMobilityAnalysis({ body_regions: merged.body_regions, mobility_tests: merged.mobility_tests });

  for (const [col, val] of Object.entries({ mobility_score: analysis.mobilityScore, mobility_category: analysis.mobilityCategory })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_mobility_performance_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

const postureAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: z.string().optional().nullable(),

    front_issues: z.array(z.string()).optional().nullable(),
    side_issues: z.array(z.string()).optional().nullable(),
    back_issues: z.array(z.string()).optional().nullable(),
    other_issue_notes: z.string().max(1000).optional().nullable(),

    coach_notes: z.record(z.string(), z.string()).optional().nullable(),
  }),
};

function computePostureAnalysis(b) {
  const postureRiskScore = postureScoring.calcPostureRiskScore(b.front_issues ?? null, b.side_issues ?? null, b.back_issues ?? null);
  const postureRiskLevel = postureScoring.classifyRisk(postureRiskScore);
  return { postureRiskScore, postureRiskLevel };
}

router.get('/posture-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation: this table missed the 084 sweep the same way
  // mobility-performance-assessments did — see that route for the finding.
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_posture_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/posture-assessments', auth, requireRole('admin', 'manager', 'trainer'), validate(postureAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computePostureAnalysis(b);

  const { rows } = await pool.query(
    `INSERT INTO pt_posture_assessments (
       client_id, assessment_number, assessment_date,
       front_issues, side_issues, back_issues, other_issue_notes,
       posture_risk_score, posture_risk_level,
       coach_notes, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_posture_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,$4,$5,$6,
       $7,$8,
       $9::jsonb,$10,$11
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || null,
      b.front_issues && b.front_issues.length ? b.front_issues : null,
      b.side_issues && b.side_issues.length ? b.side_issues : null,
      b.back_issues && b.back_issues.length ? b.back_issues : null,
      b.other_issue_notes || null,
      analysis.postureRiskScore, analysis.postureRiskLevel,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/posture-assessments/:id', auth, wrap(async (req, res) => {
  const allowed = ['assessment_date', 'front_issues', 'side_issues', 'back_issues', 'other_issue_notes', 'coach_notes'];

  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_posture_assessments WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = key === 'coach_notes' && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computePostureAnalysis({ front_issues: merged.front_issues, side_issues: merged.side_issues, back_issues: merged.back_issues });

  for (const [col, val] of Object.entries({ posture_risk_score: analysis.postureRiskScore, posture_risk_level: analysis.postureRiskLevel })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_posture_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

module.exports = router;
