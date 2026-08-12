// Everything you need to know about a client before writing them a programme.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The information required to design a workout is already in this database,
// spread across six screens a trainer would otherwise open one at a time:
// PAR-Q for medical clearance, fitness testing for capacity, posture and
// mobility for what the body will not do yet, lifestyle for how much recovery
// there is to spend, and goals for what it is all for.
//
// Nobody opens six screens before writing a programme. So they write it from
// memory, and the assessment data sits unread.
//
// ── The rule this file follows ─────────────────────────────────────────────
//
// It reports what was measured and it reports what is MISSING, and it never
// fills a gap with a guess.
//
// That second half is the important one. A brief that quietly omits the
// sections nobody has filled in reads as a complete picture of a client, and
// a trainer — or a model being handed this as context — will design against
// it as though it were. Every section therefore carries its own presence flag
// and its own date, so "no known injuries" is visibly different from "nobody
// has asked".

/** Sections a brief can carry, in the order a trainer would want to read them. */
const SECTIONS = ['readiness', 'body', 'capacity', 'limitations', 'lifestyle', 'goal', 'history'];

/** Whole years between a date of birth and today, or null. */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** A number, or null — never NaN, never a string that renders as one. */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * JSONB that may hold an array, an object of flags, or nothing.
 *
 * The assessment screens store issue lists in several shapes depending on
 * which one wrote them; this flattens to a plain list of labels and drops
 * anything it cannot read rather than rendering "[object Object]" into a
 * clinical summary.
 */
function labelsFrom(value) {
  if (!value) return [];
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === 'string' ? v : v?.label ?? v?.name ?? v?.region ?? null)).filter(Boolean);
  }
  if (typeof raw === 'object') {
    // { rounded_shoulders: true, forward_head: false } → ['rounded shoulders']
    //
    // Strictly `true`. PAR-Q's past_history mixes booleans with a free-text
    // `occupation: "Student"`, and a truthiness test would report a client's
    // job as a medical condition.
    return Object.entries(raw)
      .filter(([, v]) => v === true || v === 'yes' || v === 'Yes')
      .map(([k]) => k.replace(/_/g, ' '));
  }
  return [];
}

/**
 * The mobility screen's findings, keeping WHY each region matters.
 *
 * body_regions is an array of objects — { region, score, pain, restriction } —
 * one per joint tested, including the ones that came back clean. Flattening it
 * to names would list every joint as a problem; running it through labelsFrom
 * returned an empty list, because these objects have no `label` or `name`, so
 * a client with a restricted AND painful neck reported no restrictions at all.
 * Verified against live data, which is the only reason this was found.
 *
 * Only regions with pain or restriction come back — those are the ones that
 * change what you may prescribe.
 */
function mobilityFindings(value) {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object' && (r.pain === true || r.restriction === true))
    .map((r) => ({
      region: r.region ?? r.label ?? r.name ?? 'Unknown region',
      pain: r.pain === true,
      restriction: r.restriction === true,
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Free text a trainer typed, from a column that may not hold text.
 *
 * The assessment screens save their notes as a JSONB OBJECT with one field per
 * prompt — { summary, observations, precautions, … } — while the older screens
 * save a plain string. This brief typed them all as strings and passed them
 * through untouched, so the object reached the browser and was handed to React
 * as a child: "Objects are not valid as a React child", thrown in the middle
 * of the render.
 *
 * That is not a broken card. A throw during render unwinds to the nearest
 * boundary, which is the whole /pt-os segment — so opening one client's brief
 * took out Workout Plans, sessions and assessments with it. And because an
 * object whose every value is an empty string is still truthy, it threw for
 * every client whose PAR-Q had ever been opened, not just the ones with notes.
 *
 * Flattened rather than dropped: these are words a trainer wrote about a
 * client, and a brief that quietly discards them is the same failure this file
 * exists to prevent. Empty prompts are omitted; an object with nothing in it
 * becomes null, which is what "no notes" should have looked like all along.
 */
function textFrom(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    // Some rows hold the JSON as text rather than as jsonb.
    if (t.startsWith('{') || t.startsWith('[')) {
      const parsed = safeParse(t);
      if (parsed && typeof parsed === 'object') return textFrom(parsed);
    }
    return t;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const items = value.map((v) => textFrom(v)).filter(Boolean);
    return items.length ? items.join('\n') : null;
  }

  if (typeof value === 'object') {
    // "movement_limitations" → "Movement limitations: …", so the prompt the
    // trainer was answering survives into the brief.
    const lines = Object.entries(value)
      .map(([k, v]) => [k, textFrom(v)])
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ${v}`);
    return lines.length ? lines.join('\n') : null;
  }

  return null;
}

/**
 * Assemble the brief from rows the caller has already fetched.
 *
 * Pure, so the shape of the thing a trainer reads can be tested without a
 * database — and so the "missing" logic, which is the part that matters, is
 * testable directly.
 */
function buildBrief({
  client, parq, assessment, posture, mobility, lifestyle, goal, assignment, recentSessions = [],
}) {
  const sections = {};

  // ── Readiness: is it safe to train them, and does anything need working
  // around. The gate status is the studio's own decision, recorded on the form.
  sections.readiness = parq ? {
    present: true,
    as_of: dateOf(parq.assessment_date),
    risk_level: parq.risk_level ?? null,
    risk_message: parq.risk_message ?? null,
    gate_status: parq.workout_gate_status ?? null,
    flagged_answers: num(parq.parq_yes_count),
    current_health: labelsFrom(parq.current_health),
    past_history: labelsFrom(parq.past_history),
    blood_group: parq.blood_group ?? null,
    notes: textFrom(parq.trainer_notes),
  } : { present: false };

  sections.body = assessment ? {
    present: true,
    as_of: dateOf(assessment.assessment_date),
    height_cm: num(assessment.height_cm),
    weight_kg: num(assessment.weight),
    bmi: num(assessment.bmi),
    body_fat_pct: num(assessment.body_fat_pct),
    lean_mass_kg: num(assessment.lean_body_mass_kg),
    waist_cm: num(assessment.waist_cm),
    waist_hip_ratio: num(assessment.waist_hip_ratio),
    resting_hr: num(assessment.resting_heart_rate),
    bp: assessment.bp_systolic && assessment.bp_diastolic
      ? `${assessment.bp_systolic}/${assessment.bp_diastolic}` : null,
    bp_category: assessment.bp_category ?? null,
  } : { present: false };

  // ── Capacity: what they can currently do. Scores are the studio's own
  // computed values from the fitness test; categories are the words that go
  // with them, kept together so a number never appears without its scale.
  sections.capacity = assessment ? {
    present: true,
    as_of: dateOf(assessment.assessment_date),
    overall: num(assessment.overall_fitness_score),
    strength: { score: num(assessment.strength_score_computed ?? assessment.strength_score), category: assessment.strength_category ?? null },
    cardio: { score: num(assessment.cardio_score_computed ?? assessment.cardio_score), category: assessment.cardio_category ?? null, vo2_max: num(assessment.vo2_max) },
    endurance: { score: num(assessment.endurance_score_computed), category: assessment.endurance_category ?? null },
    flexibility: { score: num(assessment.flexibility_score), category: assessment.flexibility_category ?? null },
  } : { present: false };

  // ── Limitations: the section that changes exercise SELECTION rather than
  // volume. Posture and mobility are separate assessments and either may be
  // absent on its own, so presence is per-source.
  const postureIssues = posture
    ? [...labelsFrom(posture.front_issues), ...labelsFrom(posture.side_issues), ...labelsFrom(posture.back_issues)]
    : [];
  sections.limitations = (posture || mobility || client?.injuries) ? {
    present: true,
    posture: posture ? {
      as_of: dateOf(posture.assessment_date),
      risk_level: posture.posture_risk_level ?? null,
      issues: postureIssues,
      notes: textFrom(posture.coach_notes),
    } : null,
    mobility: mobility ? {
      as_of: dateOf(mobility.assessment_date),
      category: mobility.mobility_category ?? null,
      score: num(mobility.mobility_score),
      // Only the joints that came back painful or restricted, each carrying
      // which of the two it was — "restricted" and "painful" call for
      // different changes to a programme.
      findings: mobilityFindings(mobility.body_regions),
      notes: textFrom(mobility.performance_notes),
    } : null,
    // Free text the trainer typed on the client record. Carried verbatim: it
    // is the one place an injury nobody ran an assessment for gets recorded.
    injuries: textFrom(client?.injuries),
    has_asymmetry: assessment?.has_asymmetry ?? null,
  } : { present: false };

  // ── Lifestyle: how much training this person can actually recover from.
  sections.lifestyle = lifestyle ? {
    present: true,
    as_of: dateOf(lifestyle.assessment_date),
    experience_level: lifestyle.workout_experience_level ?? null,
    years_training: num(lifestyle.years_of_experience),
    sleep_hours: num(lifestyle.sleep_duration_hours),
    sleep_quality: lifestyle.sleep_quality ?? null,
    stress_level: lifestyle.stress_level ?? null,
    occupation_type: lifestyle.occupation_type ?? null,
    activity_level: lifestyle.activity_level ?? null,
    daily_steps: lifestyle.daily_steps_bracket ?? null,
    energy_level: lifestyle.energy_level ?? null,
    recovery_quality: lifestyle.recovery_quality ?? null,
    recovery_risk: lifestyle.recovery_risk ?? null,
    lifestyle_score: num(lifestyle.lifestyle_score),
    notes: textFrom(lifestyle.coach_notes),
  } : { present: false };

  sections.goal = goal ? {
    present: true,
    as_of: dateOf(goal.created_at),
    goal_type: goal.goal_type ?? null,
    priority: goal.priority_goal ?? null,
    description: textFrom(goal.goal_description),
    target_weight: num(goal.target_weight),
    target_body_fat: num(goal.target_body_fat),
    target_date: dateOf(goal.target_date),
    commitment_level: goal.commitment_level ?? null,
    motivation_level: goal.motivation_level ?? null,
    challenges: labelsFrom(goal.biggest_challenges),
    estimated_weeks: num(goal.estimated_duration_weeks),
  } : { present: false };

  // ── History: what they are running now and whether they turn up. Read from
  // the log rather than from the plan, because a programme on paper and a
  // programme being performed are different things.
  const completed = recentSessions.filter((s) => s.status === 'completed').length;
  sections.history = assignment ? {
    present: true,
    plan_id: assignment.plan_id,
    plan_name: assignment.plan_name,
    started_on: dateOf(assignment.start_date),
    duration_weeks: num(assignment.duration_weeks),
    days_per_week: num(assignment.planned_days_count),
    progress_pct: num(assignment.progress_pct),
    sessions_last_4_weeks: recentSessions.length,
    completed_last_4_weeks: completed,
  } : { present: false };

  const missing = SECTIONS.filter((k) => !sections[k].present);

  return {
    client: {
      id: client?.id ?? null,
      name: client?.name ?? null,
      gender: client?.gender ?? null,
      age: ageFrom(client?.dob),
      goal: client?.goal ?? null,
      notes: textFrom(client?.notes),
    },
    sections,
    // Named explicitly rather than left for the reader to notice. A brief that
    // hides its gaps gets designed against as though it were complete.
    missing,
    completeness_pct: Math.round(((SECTIONS.length - missing.length) / SECTIONS.length) * 100),
  };
}

/** YYYY-MM-DD, or null. Dates arrive from pg as Date or string depending. */
function dateOf(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
}

module.exports = { buildBrief, ageFrom, labelsFrom, mobilityFindings, textFrom, SECTIONS };
